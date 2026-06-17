// DB_PATH=:memory: se pasa via env al correr los tests
import { test, describe } from 'node:test';
import { strictEqual, ok, throws, notStrictEqual } from 'node:assert';
import {
  getUserCount,
  createUser,
  checkPassword,
  createToken,
  listTokens,
  deleteToken,
  validateToken,
} from '../db.js';

describe('users', () => {
  test('getUserCount retorna 0 en DB vacía', () => {
    strictEqual(getUserCount(), 0);
  });

  test('createUser + checkPassword correcto', () => {
    createUser('alice', 'password123');
    strictEqual(checkPassword('alice', 'password123'), true);
  });

  test('checkPassword incorrecto retorna false', () => {
    strictEqual(checkPassword('alice', 'wrong'), false);
  });

  test('checkPassword con usuario inexistente retorna false', () => {
    strictEqual(checkPassword('nadie', 'pass'), false);
  });

  test('createUser duplicado lanza error', () => {
    throws(() => createUser('alice', 'otrapass'));
  });

  test('getUserCount retorna 1 tras crear usuario', () => {
    strictEqual(getUserCount(), 1);
  });
});

describe('tokens', () => {
  let tokenValue;

  test('createToken retorna string hex de 64 chars', () => {
    tokenValue = createToken('mi token', 1);
    strictEqual(typeof tokenValue, 'string');
    strictEqual(tokenValue.length, 64);
    ok(/^[0-9a-f]+$/.test(tokenValue), 'debe ser hex válido');
  });

  test('dos tokens consecutivos son distintos', () => {
    const t2 = createToken('otro token', 1);
    notStrictEqual(tokenValue, t2);
  });

  test('validateToken con token válido retorna true', () => {
    strictEqual(validateToken(tokenValue), true);
  });

  test('validateToken con basura retorna false', () => {
    strictEqual(validateToken('aaaabbbbccccddddeeeeffff00001111'), false);
  });

  test('listTokens muestra preview truncado', () => {
    const tokens = listTokens();
    ok(tokens.length >= 1);
    ok(tokens[0].preview.endsWith('...'));
    strictEqual(tokens[0].preview.length, 11); // 8 chars + '...'
  });

  test('deleteToken elimina el token', () => {
    const tokens = listTokens();
    const id = tokens.find((t) => t.preview === `${tokenValue.slice(0, 8)}...`).id;
    const changes = deleteToken(id);
    strictEqual(changes, 1);
    strictEqual(validateToken(tokenValue), false);
  });
});
