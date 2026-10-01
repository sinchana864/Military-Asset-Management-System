CREATE TABLE IF NOT EXISTS bases (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(12) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS equipment (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  category VARCHAR(80) NOT NULL,
  unit VARCHAR(40) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash VARCHAR(160) NOT NULL,
  role ENUM('Admin', 'Base Commander', 'Logistics Officer') NOT NULL,
  base_id INT UNSIGNED NULL,
  CONSTRAINT fk_users_base FOREIGN KEY (base_id) REFERENCES bases(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS assignments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  base_id INT UNSIGNED NOT NULL,
  equipment_id INT UNSIGNED NOT NULL,
  person_name VARCHAR(100) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  expended_quantity INT UNSIGNED NOT NULL DEFAULT 0,
  occurred_at DATETIME(3) NOT NULL,
  created_by INT UNSIGNED NOT NULL,
  CONSTRAINT chk_assignment_quantity CHECK (quantity > 0),
  CONSTRAINT chk_assignment_expended CHECK (expended_quantity <= quantity),
  CONSTRAINT fk_assignments_base FOREIGN KEY (base_id) REFERENCES bases(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assignments_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assignments_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_assignments_base_equipment (base_id, equipment_id),
  INDEX idx_assignments_date (occurred_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS movements (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('Purchase', 'Transfer', 'Assignment', 'Expenditure') NOT NULL,
  equipment_id INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  base_id INT UNSIGNED NULL,
  from_base_id INT UNSIGNED NULL,
  to_base_id INT UNSIGNED NULL,
  assignment_id INT UNSIGNED NULL,
  reference VARCHAR(80) NULL,
  created_by INT UNSIGNED NOT NULL,
  CONSTRAINT chk_movement_quantity CHECK (quantity > 0),
  CONSTRAINT fk_movements_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE RESTRICT,
  CONSTRAINT fk_movements_base FOREIGN KEY (base_id) REFERENCES bases(id) ON DELETE RESTRICT,
  CONSTRAINT fk_movements_from_base FOREIGN KEY (from_base_id) REFERENCES bases(id) ON DELETE RESTRICT,
  CONSTRAINT fk_movements_to_base FOREIGN KEY (to_base_id) REFERENCES bases(id) ON DELETE RESTRICT,
  CONSTRAINT fk_movements_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_movements_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_movements_date_equipment (occurred_at, equipment_id),
  INDEX idx_movements_base_date (base_id, occurred_at),
  INDEX idx_movements_from_date (from_base_id, occurred_at),
  INDEX idx_movements_to_date (to_base_id, occurred_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id INT UNSIGNED NULL,
  details JSON NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_audit_date (occurred_at),
  INDEX idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB;
