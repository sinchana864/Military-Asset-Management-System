import express from 'express';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3001);
const secret = process.env.JWT_SECRET || 'development-only-change-this-secret';
if (process.env.NODE_ENV === 'production' && secret === 'development-only-change-this-secret') {
  throw new Error('Set JWT_SECRET before starting in production.');
}
if (!process.env.MYSQL_PASSWORD) {
  throw new Error('Set MYSQL_PASSWORD in your local .env file before starting the API.');
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'fieldstock_app',
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'fieldstock',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  timezone: 'Z',
  dateStrings: true,
});

const query = async (sql, values = {}, executor = pool) => {
  const [rows] = await executor.execute(sql, values);
  return rows;
};
const insert = async (sql, values, executor = pool) => {
  const [result] = await executor.execute(sql, values);
  return Number(result.insertId);
};
const inTransaction = async (operation) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const toMysqlDate = (value) => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
const toIsoDate = (value) => value instanceof Date ? value.toISOString() : `${String(value).replace(' ', 'T')}Z`;
const formatDateRows = (rows) => rows.map((row) => ({ ...row, occurred_at: toIsoDate(row.occurred_at) }));
const dateValue = (input, fallback) => input && !Number.isNaN(Date.parse(input)) ? new Date(input).toISOString() : fallback;
const dateBound = (input, fallback, endOfDay = false) => input && /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : dateValue(input, fallback);
const filtersFor = (req) => ({
  from: dateBound(req.query.from, '1970-01-01T00:00:00.000Z'),
  to: dateBound(req.query.to, '9999-12-31T23:59:59.999Z', true),
  baseId: req.user.role === 'Base Commander' ? req.user.baseId : req.query.baseId ? Number(req.query.baseId) : null,
  equipmentId: req.query.equipmentId ? Number(req.query.equipmentId) : null,
});
const baseFilter = (filters, alias = 'base_id') => filters.baseId ? ` AND ${alias} = :baseId` : '';
const equipmentFilter = (filters, alias = 'equipment_id') => filters.equipmentId ? ` AND ${alias} = :equipmentId` : '';
const queryFilters = (filters) => ({ ...filters, from: toMysqlDate(filters.from), to: toMysqlDate(filters.to) });
const publicUser = (user) => ({ id: Number(user.id), username: user.username, role: user.role, baseId: user.base_id === null ? null : Number(user.base_id), baseName: user.base_name || null });
const hashPassword = (password, salt = randomBytes(15).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const verifyPassword = (password, encoded) => {
  const [salt, expected] = String(encoded || '').split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBytes = Buffer.from(expected, 'hex');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
};
const logAudit = (user, action, entityType, entityId, details, connection) => insert(
  'INSERT INTO audit_log (action, entity_type, entity_id, details, occurred_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
  [action, entityType, entityId, JSON.stringify(details), toMysqlDate(new Date()), user.id],
  connection,
);
const isBaseAllowed = (user, baseId) => user.role !== 'Base Commander' || Number(baseId) === user.baseId;
const assertBase = (user, baseId) => {
  if (!isBaseAllowed(user, baseId)) throw Object.assign(new Error('This operation is outside your assigned base.'), { status: 403 });
};
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

async function initializeDatabase() {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schema = await readFile(schemaPath, 'utf8');
  for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(statement);

  const [{ count }] = await query('SELECT COUNT(*) AS count FROM bases');
  if (Number(count)) return;

  await inTransaction(async (connection) => {
    await query('INSERT INTO bases (name, code) VALUES (?, ?), (?, ?), (?, ?)', ['Northgate', 'NG', 'Redstone', 'RS', 'Westhaven', 'WH'], connection);
    const bases = await query('SELECT id, code FROM bases ORDER BY id', [], connection);
    await query('INSERT INTO equipment (name, category, unit) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)', [
      'Utility Vehicle', 'Vehicles', 'vehicles', 'Patrol Vehicle', 'Vehicles', 'vehicles',
      'Service Rifle', 'Weapons', 'units', 'Radio Set', 'Communications', 'sets',
      'Field Ration Pack', 'Supplies', 'cases',
    ], connection);
    const equipment = await query('SELECT id, name FROM equipment ORDER BY id', [], connection);
    const users = [
      ['admin', 'admin123!', 'Admin', null],
      ['commander', 'command123!', 'Base Commander', Number(bases[0].id)],
      ['logistics', 'logistics123!', 'Logistics Officer', null],
    ];
    const userIds = [];
    for (const [username, password, role, baseId] of users) {
      userIds.push(await insert('INSERT INTO users (username, password_hash, role, base_id) VALUES (?, ?, ?, ?)', [username, hashPassword(password), role, baseId], connection));
    }
    const now = Date.now();
    const day = (offset) => toMysqlDate(new Date(now + offset * 86400000));
    const adminId = userIds[0];
    const opening = [
      [equipment[0].id, 34, bases[0].id], [equipment[1].id, 11, bases[0].id], [equipment[2].id, 180, bases[0].id],
      [equipment[3].id, 42, bases[0].id], [equipment[0].id, 18, bases[1].id], [equipment[2].id, 120, bases[1].id],
      [equipment[3].id, 27, bases[1].id], [equipment[0].id, 22, bases[2].id], [equipment[2].id, 90, bases[2].id],
      [equipment[4].id, 16, bases[0].id],
    ];
    for (const [index, [equipmentId, quantity, baseId]] of opening.entries()) {
      await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, reference, created_by) VALUES ('Purchase', ?, ?, ?, ?, ?, ?)", [equipmentId, quantity, day(-35 + index % 4), baseId, `PO-${2400 + index}`, adminId], connection);
    }
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, from_base_id, to_base_id, reference, created_by) VALUES ('Transfer', ?, ?, ?, ?, ?, ?, ?)", [equipment[2].id, 12, day(-8), bases[0].id, bases[1].id, 'TR-0084', adminId], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, reference, created_by) VALUES ('Purchase', ?, ?, ?, ?, ?, ?)", [equipment[3].id, 8, day(-3), bases[0].id, 'PO-2418', adminId], connection);
    const firstAssignment = await insert('INSERT INTO assignments (base_id, equipment_id, person_name, quantity, occurred_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [bases[0].id, equipment[2].id, 'Sgt. Morgan', 8, day(-6), userIds[1]], connection);
    const secondAssignment = await insert('INSERT INTO assignments (base_id, equipment_id, person_name, quantity, occurred_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [bases[0].id, equipment[0].id, 'Lt. Avery', 1, day(-2), userIds[1]], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Assignment', ?, ?, ?, ?, ?, ?)", [equipment[2].id, 8, day(-6), bases[0].id, firstAssignment, userIds[1]], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Assignment', ?, ?, ?, ?, ?, ?)", [equipment[0].id, 1, day(-2), bases[0].id, secondAssignment, userIds[1]], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Expenditure', ?, ?, ?, ?, ?, ?)", [equipment[2].id, 2, day(-1), bases[0].id, firstAssignment, userIds[1]], connection);
    await query('UPDATE assignments SET expended_quantity = 2 WHERE id = ?', [firstAssignment], connection);
  });
}

app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const auth = asyncRoute(async (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  let payload;
  try {
    if (!token) throw new Error('Missing token');
    payload = jwt.verify(token, secret);
  } catch {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const rows = await query('SELECT u.*, b.name AS base_name FROM users u LEFT JOIN bases b ON b.id = u.base_id WHERE u.id = ?', [payload.sub]);
  if (!rows[0]) return res.status(401).json({ error: 'Authentication required.' });
  req.user = publicUser(rows[0]);
  next();
});
const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role cannot perform this action.' });

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const rows = await query('SELECT u.*, b.name AS base_name FROM users u LEFT JOIN bases b ON b.id = u.base_id WHERE u.username = ?', [String(username || '')]);
  const user = rows[0];
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = jwt.sign({}, secret, { subject: String(user.id), expiresIn: '8h' });
  res.json({ token, user: publicUser(user) });
}));
app.get('/api/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, database: 'mysql' });
}));
app.use('/api', auth);
app.get('/api/me', (req, res) => res.json({ user: req.user }));
app.get('/api/bases', asyncRoute(async (req, res) => {
  const bases = await query('SELECT id, name, code FROM bases ORDER BY name', []);
  res.json(bases.filter((base) => isBaseAllowed(req.user, base.id)));
}));
app.get('/api/equipment', asyncRoute(async (_req, res) => {
  res.json(await query('SELECT id, name, category, unit FROM equipment ORDER BY category, name', []));
}));
app.get('/api/summary', asyncRoute(async (req, res) => {
  const filters = filtersFor(req);
  const args = { ...filters, from: toMysqlDate(filters.from), to: toMysqlDate(filters.to) };
  const rows = await query(`SELECT * FROM movements WHERE occurred_at <= :to${filters.baseId ? ' AND (base_id = :baseId OR from_base_id = :baseId OR to_base_id = :baseId)' : ''}${equipmentFilter(filters)} ORDER BY occurred_at`, args);
  rows.forEach((row) => { row.occurred_at = toIsoDate(row.occurred_at); });
  const relevantBase = (row) => !filters.baseId || row.base_id === filters.baseId || row.from_base_id === filters.baseId || row.to_base_id === filters.baseId;
  const equipmentRows = await query('SELECT id, name, category, unit FROM equipment ORDER BY category, name', []);
  const equipment = equipmentRows.filter((item) => !filters.equipmentId || item.id === filters.equipmentId).map((item) => {
    const itemRows = rows.filter((row) => row.equipment_id === item.id && relevantBase(row));
    const tally = { opening: 0, closing: 0, purchases: 0, transferIn: 0, transferOut: 0, assigned: 0, expended: 0 };
    for (const row of itemRows) {
      const inPeriod = row.occurred_at >= filters.from && row.occurred_at <= filters.to;
      let delta = 0;
      if (row.kind === 'Purchase' && (!filters.baseId || row.base_id === filters.baseId)) { delta = row.quantity; if (inPeriod) tally.purchases += row.quantity; }
      if (row.kind === 'Transfer') {
        if (!filters.baseId || row.to_base_id === filters.baseId) { delta += row.quantity; if (inPeriod) tally.transferIn += row.quantity; }
        if (!filters.baseId || row.from_base_id === filters.baseId) { delta -= row.quantity; if (inPeriod) tally.transferOut += row.quantity; }
      }
      if (row.kind === 'Expenditure' && (!filters.baseId || row.base_id === filters.baseId)) { delta -= row.quantity; if (inPeriod) tally.expended += row.quantity; }
      if (inPeriod && row.kind === 'Assignment' && (!filters.baseId || row.base_id === filters.baseId)) tally.assigned += row.quantity;
      if (row.occurred_at < filters.from) tally.opening += delta;
      tally.closing += delta;
    }
    return { ...item, ...tally, netMovement: tally.purchases + tally.transferIn - tally.transferOut };
  });
  const total = equipment.reduce((acc, item) => {
    for (const key of ['opening', 'closing', 'purchases', 'transferIn', 'transferOut', 'assigned', 'expended']) acc[key] += item[key];
    return acc;
  }, { opening: 0, closing: 0, purchases: 0, transferIn: 0, transferOut: 0, assigned: 0, expended: 0 });
  if (req.user.role === 'Logistics Officer') {
    delete total.assigned;
    delete total.expended;
    equipment.forEach((item) => { delete item.assigned; delete item.expended; });
  }
  res.json({ ...total, netMovement: total.purchases + total.transferIn - total.transferOut, equipment });
}));
app.get('/api/purchases', allow('Admin', 'Base Commander', 'Logistics Officer'), asyncRoute(async (req, res) => {
  const filters = filtersFor(req);
  const rows = await query(`SELECT m.*, e.name AS equipment_name, e.category, e.unit, b.name AS base_name, u.username AS recorded_by FROM movements m JOIN equipment e ON e.id = m.equipment_id JOIN bases b ON b.id = m.base_id JOIN users u ON u.id = m.created_by WHERE m.kind = 'Purchase' AND m.occurred_at BETWEEN :from AND :to${baseFilter(filters, 'm.base_id')}${equipmentFilter(filters, 'm.equipment_id')} ORDER BY m.occurred_at DESC`, { ...filters, from: toMysqlDate(filters.from), to: toMysqlDate(filters.to) });
  res.json(formatDateRows(rows));
}));
app.post('/api/purchases', allow('Admin', 'Base Commander', 'Logistics Officer'), asyncRoute(async (req, res) => {
  const { baseId, equipmentId, quantity, reference, occurredAt } = req.body || {};
  assertBase(req.user, baseId);
  if (!Number.isInteger(Number(quantity)) || Number(quantity) < 1) return res.status(400).json({ error: 'Quantity must be a positive whole number.' });
  const valid = await query('SELECT (SELECT COUNT(*) FROM equipment WHERE id = ?) AS equipment_count, (SELECT COUNT(*) FROM bases WHERE id = ?) AS base_count', [Number(equipmentId), Number(baseId)]);
  if (!valid[0].equipment_count || !valid[0].base_count) return res.status(400).json({ error: 'Choose a valid base and equipment type.' });
  const id = await inTransaction(async (connection) => {
    const movementId = await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, reference, created_by) VALUES ('Purchase', ?, ?, ?, ?, ?, ?)", [Number(equipmentId), Number(quantity), toMysqlDate(dateValue(occurredAt, new Date().toISOString())), Number(baseId), String(reference || '').slice(0, 80), req.user.id], connection);
    await logAudit(req.user, 'purchase.recorded', 'movement', movementId, { baseId: Number(baseId), equipmentId: Number(equipmentId), quantity: Number(quantity), reference }, connection);
    return movementId;
  });
  res.status(201).json({ id });
}));
app.get('/api/transfers', allow('Admin', 'Base Commander', 'Logistics Officer'), asyncRoute(async (req, res) => {
  const filters = filtersFor(req);
  const rows = await query(`SELECT m.*, e.name AS equipment_name, e.category, e.unit, src.name AS from_base, dst.name AS to_base, u.username AS recorded_by FROM movements m JOIN equipment e ON e.id = m.equipment_id JOIN bases src ON src.id = m.from_base_id JOIN bases dst ON dst.id = m.to_base_id JOIN users u ON u.id = m.created_by WHERE m.kind = 'Transfer' AND m.occurred_at BETWEEN :from AND :to${filters.baseId ? ' AND (m.from_base_id = :baseId OR m.to_base_id = :baseId)' : ''}${equipmentFilter(filters, 'm.equipment_id')} ORDER BY m.occurred_at DESC`, { ...filters, from: toMysqlDate(filters.from), to: toMysqlDate(filters.to) });
  res.json(formatDateRows(rows));
}));
app.post('/api/transfers', allow('Admin', 'Base Commander', 'Logistics Officer'), asyncRoute(async (req, res) => {
  const { fromBaseId, toBaseId, equipmentId, quantity, reference, occurredAt } = req.body || {};
  assertBase(req.user, fromBaseId);
  if (Number(fromBaseId) === Number(toBaseId)) return res.status(400).json({ error: 'Choose two different bases.' });
  if (!Number.isInteger(Number(quantity)) || Number(quantity) < 1) return res.status(400).json({ error: 'Quantity must be a positive whole number.' });
  const valid = await query('SELECT (SELECT COUNT(*) FROM bases WHERE id = ?) AS from_count, (SELECT COUNT(*) FROM bases WHERE id = ?) AS to_count, (SELECT COUNT(*) FROM equipment WHERE id = ?) AS equipment_count', [Number(fromBaseId), Number(toBaseId), Number(equipmentId)]);
  if (!valid[0].from_count || !valid[0].to_count || !valid[0].equipment_count) return res.status(400).json({ error: 'Choose valid bases and equipment.' });
  const id = await inTransaction(async (connection) => {
    await query('SELECT id FROM bases WHERE id = ? FOR UPDATE', [Number(fromBaseId)], connection);
    const stock = await query("SELECT COALESCE(SUM(CASE WHEN kind = 'Purchase' AND base_id = :baseId THEN quantity WHEN kind = 'Transfer' AND to_base_id = :baseId THEN quantity WHEN kind = 'Transfer' AND from_base_id = :baseId THEN -quantity WHEN kind = 'Expenditure' AND base_id = :baseId THEN -quantity ELSE 0 END), 0) AS on_hand FROM movements WHERE equipment_id = :equipmentId", { baseId: Number(fromBaseId), equipmentId: Number(equipmentId) }, connection);
    const assigned = await query('SELECT COALESCE(SUM(quantity - expended_quantity), 0) AS quantity FROM assignments WHERE base_id = ? AND equipment_id = ?', [Number(fromBaseId), Number(equipmentId)], connection);
    if (Number(stock[0].on_hand) - Number(assigned[0].quantity) < Number(quantity)) throw Object.assign(new Error('Not enough unassigned stock is available at the sending base.'), { status: 409 });
    const movementId = await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, from_base_id, to_base_id, reference, created_by) VALUES ('Transfer', ?, ?, ?, ?, ?, ?, ?)", [Number(equipmentId), Number(quantity), toMysqlDate(dateValue(occurredAt, new Date().toISOString())), Number(fromBaseId), Number(toBaseId), String(reference || '').slice(0, 80), req.user.id], connection);
    await logAudit(req.user, 'transfer.recorded', 'movement', movementId, { fromBaseId: Number(fromBaseId), toBaseId: Number(toBaseId), equipmentId: Number(equipmentId), quantity: Number(quantity), reference }, connection);
    return movementId;
  });
  res.status(201).json({ id });
}));
app.get('/api/assignments', allow('Admin', 'Base Commander'), asyncRoute(async (req, res) => {
  const filters = filtersFor(req);
  const rows = await query(`SELECT a.*, e.name AS equipment_name, e.category, e.unit, b.name AS base_name, u.username AS recorded_by FROM assignments a JOIN equipment e ON e.id = a.equipment_id JOIN bases b ON b.id = a.base_id JOIN users u ON u.id = a.created_by WHERE a.occurred_at BETWEEN :from AND :to${baseFilter(filters, 'a.base_id')}${equipmentFilter(filters, 'a.equipment_id')} ORDER BY a.occurred_at DESC`, { ...filters, from: toMysqlDate(filters.from), to: toMysqlDate(filters.to) });
  res.json(formatDateRows(rows));
}));
app.post('/api/assignments', allow('Admin', 'Base Commander'), asyncRoute(async (req, res) => {
  const { baseId, equipmentId, personName, quantity, occurredAt } = req.body || {};
  assertBase(req.user, baseId);
  if (!String(personName || '').trim() || !Number.isInteger(Number(quantity)) || Number(quantity) < 1) return res.status(400).json({ error: 'Enter a person and a positive whole-number quantity.' });
  const valid = await query('SELECT (SELECT COUNT(*) FROM bases WHERE id = ?) AS base_count, (SELECT COUNT(*) FROM equipment WHERE id = ?) AS equipment_count', [Number(baseId), Number(equipmentId)]);
  if (!valid[0].base_count || !valid[0].equipment_count) return res.status(400).json({ error: 'Choose a valid base and equipment type.' });
  const id = await inTransaction(async (connection) => {
    await query('SELECT id FROM bases WHERE id = ? FOR UPDATE', [Number(baseId)], connection);
    const stock = await query("SELECT COALESCE(SUM(CASE WHEN kind = 'Purchase' AND base_id = :baseId THEN quantity WHEN kind = 'Transfer' AND to_base_id = :baseId THEN quantity WHEN kind = 'Transfer' AND from_base_id = :baseId THEN -quantity WHEN kind = 'Expenditure' AND base_id = :baseId THEN -quantity ELSE 0 END), 0) AS on_hand FROM movements WHERE equipment_id = :equipmentId", { baseId: Number(baseId), equipmentId: Number(equipmentId) }, connection);
    const assigned = await query('SELECT COALESCE(SUM(quantity - expended_quantity), 0) AS quantity FROM assignments WHERE base_id = ? AND equipment_id = ?', [Number(baseId), Number(equipmentId)], connection);
    if (Number(stock[0].on_hand) - Number(assigned[0].quantity) < Number(quantity)) throw Object.assign(new Error('Not enough unassigned stock is available at this base.'), { status: 409 });
    const time = toMysqlDate(dateValue(occurredAt, new Date().toISOString()));
    const assignmentId = await insert('INSERT INTO assignments (base_id, equipment_id, person_name, quantity, occurred_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [Number(baseId), Number(equipmentId), String(personName).trim().slice(0, 100), Number(quantity), time, req.user.id], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Assignment', ?, ?, ?, ?, ?, ?)", [Number(equipmentId), Number(quantity), time, Number(baseId), assignmentId, req.user.id], connection);
    await logAudit(req.user, 'assignment.created', 'assignment', assignmentId, { baseId: Number(baseId), equipmentId: Number(equipmentId), quantity: Number(quantity), personName }, connection);
    return assignmentId;
  });
  res.status(201).json({ id });
}));
app.post('/api/assignments/:id/expense', allow('Admin', 'Base Commander'), asyncRoute(async (req, res) => {
  const assignmentId = Number(req.params.id);
  const quantity = Number(req.body?.quantity);
  const rows = await query('SELECT * FROM assignments WHERE id = ?', [assignmentId]);
  const assignment = rows[0];
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  assertBase(req.user, assignment.base_id);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > assignment.quantity - assignment.expended_quantity) return res.status(400).json({ error: 'Enter a quantity within the remaining assigned amount.' });
  const movementId = await inTransaction(async (connection) => {
    const current = await query('SELECT * FROM assignments WHERE id = ? FOR UPDATE', [assignmentId], connection);
    if (!current[0] || quantity > current[0].quantity - current[0].expended_quantity) throw Object.assign(new Error('Enter a quantity within the remaining assigned amount.'), { status: 400 });
    await query('UPDATE assignments SET expended_quantity = expended_quantity + ? WHERE id = ?', [quantity, assignmentId], connection);
    const id = await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Expenditure', ?, ?, ?, ?, ?, ?)", [assignment.equipment_id, quantity, toMysqlDate(new Date()), assignment.base_id, assignmentId, req.user.id], connection);
    await logAudit(req.user, 'expenditure.recorded', 'assignment', assignmentId, { quantity, equipmentId: assignment.equipment_id, baseId: assignment.base_id }, connection);
    return id;
  });
  res.status(201).json({ id: movementId });
}));
app.get('/api/audit', allow('Admin'), asyncRoute(async (_req, res) => {
  const rows = await query('SELECT a.*, u.username FROM audit_log a JOIN users u ON u.id = a.user_id ORDER BY a.occurred_at DESC LIMIT 200', []);
  res.json(rows.map((row) => ({ ...row, occurred_at: toIsoDate(row.occurred_at), details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details })));
}));
app.use((error, _req, res, _next) => {
  if (!error.status || error.status >= 500) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Unexpected server error.' });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

try {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schema = await readFile(schemaPath, 'utf8');
  for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(statement);
  const [{ count }] = await query('SELECT COUNT(*) AS count FROM bases', []);
  if (!Number(count)) await seedDatabase();
  app.listen(port, () => console.log(`Fieldstock API listening on http://localhost:${port} (MySQL)`));
} catch (error) {
  console.error(`MySQL initialization failed: ${error.message}`);
  await pool.end();
  process.exitCode = 1;
}

async function seedDatabase() {
  await inTransaction(async (connection) => {
    await query('INSERT INTO bases (name, code) VALUES (?, ?), (?, ?), (?, ?)', ['Northgate', 'NG', 'Redstone', 'RS', 'Westhaven', 'WH'], connection);
    const bases = await query('SELECT id FROM bases ORDER BY id', [], connection);
    await query('INSERT INTO equipment (name, category, unit) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)', [
      'Utility Vehicle', 'Vehicles', 'vehicles', 'Patrol Vehicle', 'Vehicles', 'vehicles',
      'Service Rifle', 'Weapons', 'units', 'Radio Set', 'Communications', 'sets',
      'Field Ration Pack', 'Supplies', 'cases',
    ], connection);
    const equipment = await query('SELECT id FROM equipment ORDER BY id', [], connection);
    const users = [
      ['admin', 'admin123!', 'Admin', null],
      ['commander', 'command123!', 'Base Commander', bases[0].id],
      ['logistics', 'logistics123!', 'Logistics Officer', null],
    ];
    const userIds = [];
    for (const [username, password, role, baseId] of users) userIds.push(await insert('INSERT INTO users (username, password_hash, role, base_id) VALUES (?, ?, ?, ?)', [username, hashPassword(password), role, baseId], connection));
    const now = Date.now();
    const day = (offset) => toMysqlDate(new Date(now + offset * 86400000));
    const opening = [
      [equipment[0].id, 34, bases[0].id], [equipment[1].id, 11, bases[0].id], [equipment[2].id, 180, bases[0].id],
      [equipment[3].id, 42, bases[0].id], [equipment[0].id, 18, bases[1].id], [equipment[2].id, 120, bases[1].id],
      [equipment[3].id, 27, bases[1].id], [equipment[0].id, 22, bases[2].id], [equipment[2].id, 90, bases[2].id],
      [equipment[4].id, 16, bases[0].id],
    ];
    for (const [index, [equipmentId, quantity, baseId]] of opening.entries()) {
      await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, reference, created_by) VALUES ('Purchase', ?, ?, ?, ?, ?, ?)", [equipmentId, quantity, day(-35 + index % 4), baseId, `PO-${2400 + index}`, userIds[0]], connection);
    }
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, from_base_id, to_base_id, reference, created_by) VALUES ('Transfer', ?, ?, ?, ?, ?, ?, ?)", [equipment[2].id, 12, day(-8), bases[0].id, bases[1].id, 'TR-0084', userIds[0]], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, reference, created_by) VALUES ('Purchase', ?, ?, ?, ?, ?, ?)", [equipment[3].id, 8, day(-3), bases[0].id, 'PO-2418', userIds[0]], connection);
    const assignmentId = await insert('INSERT INTO assignments (base_id, equipment_id, person_name, quantity, occurred_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [bases[0].id, equipment[2].id, 'Sgt. Morgan', 8, day(-6), userIds[1]], connection);
    const secondAssignmentId = await insert('INSERT INTO assignments (base_id, equipment_id, person_name, quantity, occurred_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [bases[0].id, equipment[0].id, 'Lt. Avery', 1, day(-2), userIds[1]], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Assignment', ?, ?, ?, ?, ?, ?)", [equipment[2].id, 8, day(-6), bases[0].id, assignmentId, userIds[1]], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Assignment', ?, ?, ?, ?, ?, ?)", [equipment[0].id, 1, day(-2), bases[0].id, secondAssignmentId, userIds[1]], connection);
    await insert("INSERT INTO movements (kind, equipment_id, quantity, occurred_at, base_id, assignment_id, created_by) VALUES ('Expenditure', ?, ?, ?, ?, ?, ?)", [equipment[2].id, 2, day(-1), bases[0].id, assignmentId, userIds[1]], connection);
    await query('UPDATE assignments SET expended_quantity = 2 WHERE id = ?', [assignmentId], connection);
  });
}
