// DB_PATH=:memory: se pasa via env al correr los tests
import { test, describe } from 'node:test';
import { strictEqual, ok, notStrictEqual } from 'node:assert';
import { escHtml, parseForm, signSession, parseSession, renderLayout } from '../admin.js';

describe('escHtml', () => {
  test('escapa caracteres HTML peligrosos', () => {
    strictEqual(escHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    strictEqual(escHtml('"comillas"'), '&quot;comillas&quot;');
    strictEqual(escHtml("'apóstrofe'"), '&#39;apóstrofe&#39;');
    strictEqual(escHtml('a & b'), 'a &amp; b');
  });

  test('texto sin caracteres especiales queda igual', () => {
    strictEqual(escHtml('hello world'), 'hello world');
  });
});

describe('parseForm', () => {
  test('parsea campos básicos', () => {
    const result = parseForm('key=value&key2=value2');
    strictEqual(result.key, 'value');
    strictEqual(result.key2, 'value2');
  });

  test('decodifica valores URL-encoded', () => {
    const result = parseForm('name=Pedro+Montes&city=Medell%C3%ADn');
    strictEqual(result.name, 'Pedro Montes');
    strictEqual(result.city, 'Medellín');
  });

  test('body vacío retorna objeto vacío', () => {
    const result = parseForm('');
    strictEqual(Object.keys(result).length, 0);
  });
});

describe('sesiones HMAC', () => {
  test('signSession + parseSession con ID válido', () => {
    const id = 'abc123def456';
    const signed = signSession(id);
    ok(signed.includes('.'), 'debe tener separador punto');
    strictEqual(parseSession(signed), id);
  });

  test('sessionId modificado falla la verificación', () => {
    const id = 'legitimate-session-id';
    const signed = signSession(id);
    // Modificar un char del ID en la cookie firmada
    const tampered = 'evil-session-id.' + signed.split('.')[1];
    strictEqual(parseSession(tampered), null);
  });

  test('firma modificada falla la verificación', () => {
    const id = 'some-session';
    const signed = signSession(id);
    const parts = signed.split('.');
    // Cambiar el último char de la firma
    const badSig = parts[1].slice(0, -1) + (parts[1].endsWith('a') ? 'b' : 'a');
    strictEqual(parseSession(`${parts[0]}.${badSig}`), null);
  });

  test('cookie nula retorna null', () => {
    strictEqual(parseSession(null), null);
    strictEqual(parseSession(''), null);
    strictEqual(parseSession('sinpunto'), null);
  });
});

describe('renderLayout', () => {
  test('incluye el título en el HTML', () => {
    const html = renderLayout('Mi Título', '<p>body</p>');
    ok(html.includes('Mi Título'));
    ok(html.includes('<p>body</p>'));
  });

  test('escapa el título para prevenir XSS', () => {
    const html = renderLayout('<script>', 'body');
    ok(!html.includes('<script>') || html.includes('&lt;script&gt;'));
  });
});
