/*
Copyright 2025 Ridgeline Radio, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the “Software”), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Caller directory database (SQLite via better-sqlite3)
const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "data", "directory.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS directory (
    phone_number TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const lookupNameStmt = db.prepare(
  "SELECT name FROM directory WHERE phone_number = ?",
);
const saveNameStmt = db.prepare(`
  INSERT INTO directory (phone_number, name)
  VALUES (@phone_number, @name)
  ON CONFLICT(phone_number) DO UPDATE SET
    name = excluded.name,
    updated_at = datetime('now')
`);

// Returns the saved name for a phone number, or null if none is known.
function lookupName(phoneNumber) {
  if (!phoneNumber) return null;
  const row = lookupNameStmt.get(phoneNumber);
  return row ? row.name : null;
}

// Inserts or updates the name for a phone number.
function saveName(phoneNumber, name) {
  saveNameStmt.run({ phone_number: phoneNumber, name });
}

// Returns "Name (number)" if a name is known, otherwise the raw number.
function displayCaller(phoneNumber) {
  if (!phoneNumber) return phoneNumber;
  const name = lookupName(phoneNumber);
  return name ? `${name} (${phoneNumber})` : phoneNumber;
}

module.exports = { lookupName, saveName, displayCaller };
