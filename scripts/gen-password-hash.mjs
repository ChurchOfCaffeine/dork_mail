#!/usr/bin/env node
// Generates a bcrypt hash suitable for use as admin_password_hash in terraform.tfvars.
//
// Usage:
//   node scripts/gen-password-hash.mjs
//   node scripts/gen-password-hash.mjs 'mypassword'   # pass as arg (avoid shell history)

import { createInterface } from "readline";
import pkg from "bcryptjs";
const { hashSync } = pkg;

const ROUNDS = 12;

async function readPassword() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question("Password: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const password = process.argv[2] ?? await readPassword();

if (!password) {
  console.error("Error: password cannot be empty");
  process.exit(1);
}

const hash = hashSync(password, ROUNDS);
console.log(hash);
