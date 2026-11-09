// SC-020-A — walidacja konfiguracji marki i plików (bez bazy).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBrandConfig, brandConfigFromForm, contrastRatio, contrastChecks, normalizeHex, validateBrandAsset,
  svgProblems, brandObjectPath, brandAssetHeaders, brandCssVariables, brandingEnabled, DEFAULT_BRAND_CONFIG,
  BRAND_ASSET_LIMITS,
} from '../lib/brand-config.ts';

const config = (overrides = {}) => ({ ...structuredClone(DEFAULT_BRAND_CONFIG), ...overrides });

function png(width = 64, height = 32, extra = 0) {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
function webp(size = 40) {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from('RIFF')); new DataView(bytes.buffer).setUint32(4, size - 8, true);
  bytes.set(Buffer.from('WEBPVP8 '), 8);
  return bytes;
}
function ico(size = 70) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true); view.setUint16(4, 1, true);
  view.setUint32(6 + 8, size - 22, true); view.setUint32(6 + 12, 22, true);
  return bytes;
}
const svg = body => new TextEncoder().encode(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

test('colour helpers: hex normalisation and WCAG contrast', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' #1F3A5F '), '#1f3a5f');
  for (const bad of ['red', '#12345', '#gggggg', '1f3a5f', 12, null, 'url(x)']) assert.equal(normalizeHex(bad), null);
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.ok(contrastChecks(DEFAULT_BRAND_CONFIG.colors).every(c => c.ok), 'the default must pass its own rules');
});

test('parseBrandConfig accepts a valid config and normalises it', () => {
  const result = parseBrandConfig(config({ brandName: '  Acme  ', colors: { ...DEFAULT_BRAND_CONFIG.colors, primary: '#1F3A5F', onPrimary: '#FFF' } }));
  assert.ok(result.ok);
  assert.equal(result.value.brandName, 'Acme');
  assert.equal(result.value.colors.primary, '#1f3a5f');
  assert.equal(result.value.colors.onPrimary, '#ffffff');
});

test('parseBrandConfig rejects unknown fields, bad colours, weak contrast and unsafe text', () => {
  const cases = [
    [{ ...config(), legalNotice: 'x' }, /Nieprawidłowa konfiguracja/],
    [config({ brandName: '' }), /Nazwa marki/],
    [config({ brandName: 'a'.repeat(81) }), /Nazwa marki/],
    [config({ brandName: 'Acme <b>' }), /niedozwolone znaki/],
    [config({ brandName: 'Acme\u0007' }), /niedozwolone znaki/],
    [config({ colors: { ...DEFAULT_BRAND_CONFIG.colors, accent: 'blue' } }), /kolor akcentu/],
    [config({ colors: { ...DEFAULT_BRAND_CONFIG.colors, extra: '#000000' } }), /Nieprawidłowe kolory/],
    [config({ colors: { ...DEFAULT_BRAND_CONFIG.colors, text: '#dddddd' } }), /Za słaby kontrast: Tekst na tle/],
    [config({ colors: { ...DEFAULT_BRAND_CONFIG.colors, onPrimary: '#33506f' } }), /Tekst na kolorze głównym/],
    [config({ colors: { ...DEFAULT_BRAND_CONFIG.colors, accent: '#f5f5f5' } }), /Akcent na tle/],
    [config({ recruiterPanel: { headerStyle: 'neon' } }), /panelu rekrutera/],
    [config({ candidatePanel: { headline: 'x', intro: 'y'.repeat(601) } }), /Wstęp/],
    [config({ candidatePanel: { headline: 'x', intro: '', legal: 'no' } }), /panelu kandydata/],
  ];
  for (const [input, message] of cases) {
    const result = parseBrandConfig(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.error, message);
  }
});

test('form parsing builds exactly the four configuration groups', () => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ brandName: 'Acme', primary: '#1f3a5f', onPrimary: '#ffffff', background: '#ffffff',
    text: '#1b2433', accent: '#8a4b08', headerStyle: 'light', headline: 'Witaj', intro: 'Krótki opis', legal: 'ignored' })) form.set(k, v);
  const result = brandConfigFromForm(form);
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.value).sort(), ['brandName', 'candidatePanel', 'colors', 'recruiterPanel']);
  assert.equal(result.value.recruiterPanel.headerStyle, 'light');
});

test('css variables come only from validated hex values', () => {
  assert.deepEqual(brandCssVariables(DEFAULT_BRAND_CONFIG)['--brand-primary'], '#1f3a5f');
  assert.throws(() => brandCssVariables(config({ colors: { ...DEFAULT_BRAND_CONFIG.colors, primary: 'red;}body{x' } })));
});

test('asset validation: accepted formats by content, per kind', () => {
  assert.deepEqual(validateBrandAsset(png(), 'logo'), { ok: true, value: { mime: 'image/png', extension: 'png', size: 33 } });
  assert.equal(validateBrandAsset(webp(), 'logo').value.mime, 'image/webp');
  assert.equal(validateBrandAsset(ico(), 'favicon').value.mime, 'image/x-icon');
  assert.equal(validateBrandAsset(svg('<rect width="10" height="10" fill="#123456"/>'), 'logo').value.mime, 'image/svg+xml');
  assert.equal(validateBrandAsset(svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/>'), 'favicon').value.extension, 'svg');
  assert.match(validateBrandAsset(ico(), 'logo').error, /Logo: dozwolone/);
});

test('asset validation: size limits, empty, spoofed and broken files are rejected', () => {
  assert.match(validateBrandAsset(new Uint8Array(0), 'logo').error, /pusty/);
  assert.match(validateBrandAsset(png(64, 64, BRAND_ASSET_LIMITS.favicon), 'favicon').error, /za duży/);
  assert.ok(validateBrandAsset(png(64, 64, BRAND_ASSET_LIMITS.favicon), 'logo').ok);
  assert.match(validateBrandAsset(png(64, 64, BRAND_ASSET_LIMITS.logo), 'logo').error, /za duży/);
  assert.match(validateBrandAsset(png(5000, 10), 'logo').error, /wymiary/);
  assert.match(validateBrandAsset(png(0, 10), 'logo').error, /wymiary/);
  const brokenPng = png(); brokenPng[12] = 0; assert.match(validateBrandAsset(brokenPng, 'logo').error, /Uszkodzony/);
  const brokenWebp = webp(); new DataView(brokenWebp.buffer).setUint32(4, 999, true); assert.match(validateBrandAsset(brokenWebp, 'logo').error, /Uszkodzony/);
  const brokenIco = ico(); new DataView(brokenIco.buffer).setUint32(6 + 12, 9999, true); assert.match(validateBrandAsset(brokenIco, 'favicon').error, /Uszkodzony/);
  for (const other of ['GIF89a....', '%PDF-1.7', '<html><body>x</body></html>', 'plain text']) {
    assert.match(validateBrandAsset(new TextEncoder().encode(other), 'logo').error, /Dozwolone formaty/);
  }
  assert.match(validateBrandAsset(new Uint8Array([0xff, 0xfe, 0x3c, 0x73, 0x76, 0x67, 0x00, 0xd8]), 'logo').error, /Dozwolone formaty/);
  assert.match(validateBrandAsset(png(), 'banner').error, /Nieznany rodzaj/);
});

test('svg with script, foreignObject, handlers, external references or parser tricks is rejected', () => {
  const dangerous = [
    '<script>alert(1)</script>',
    '<SCRIPT >alert(1)</SCRIPT>',
    '<foreignObject><div>x</div></foreignObject>',
    '<rect onload="alert(1)"/>',
    '<rect\nonclick =\'x\'/>',
    '<image href="https://evil.example/x.png"/>',
    '<use xlink:href="https://evil.example/s.svg#a"/>',
    '<a href="javascript:alert(1)"><text>x</text></a>',
    '<rect fill="url(https://evil.example/x)"/>',
    '<style>@import url(https://evil.example/x.css);</style>',
    '<style>rect{fill:url(\'//evil.example/p\')}</style>',
    '<rect style="background:url(data:image/png;base64,AAAA)"/>',
    '<iframe src="x"/>',
    '<set attributeName="href" to="javascript:alert(1)"/>',
    '<animate attributeName="x" values="1"/>',
    '<![CDATA[x]]>',
    '<feImage href="#x"/>',
  ];
  for (const body of dangerous) {
    const result = validateBrandAsset(svg(body), 'logo');
    assert.equal(result.ok, false, body);
    assert.match(result.error, /SVG odrzucony/);
  }
  const doctype = new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>');
  assert.match(validateBrandAsset(doctype, 'logo').error, /SVG odrzucony/);
  const stylesheet = new TextEncoder().encode('<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/a.css"?><svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.match(validateBrandAsset(stylesheet, 'logo').error, /SVG odrzucony/);
  const html = new TextEncoder().encode('<html><svg xmlns="http://www.w3.org/2000/svg"/></html>');
  assert.match(validateBrandAsset(html, 'logo').error, /SVG odrzucony/);
  assert.deepEqual(svgProblems('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0"/></svg>'), []);
});

test('review SC-020-A #1: namespace prefixes, CSS escapes and entities cannot bypass the SVG filter', () => {
  const raw = text => new TextEncoder().encode(text);
  const bypasses = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(document.domain)</s:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject><p>x</p></s:foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:l="http://www.w3.org/1999/xlink"><s:image l:href="https://evil.example/t.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@\\69mport "https://evil.example/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:\\75rl(https://evil.example/a)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="https://evil.example"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@&#105;mport url(x)</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@media print{rect{fill:red}}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="x:1;@import"/></svg>',
    '<svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="https://evil.example/ns"><rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect ev:event="click"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><marquee/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text>&nbsp;</text></svg>',
  ];
  for (const source of bypasses) {
    const result = validateBrandAsset(raw(source), 'logo');
    assert.equal(result.ok, false, source);
    assert.match(result.error, /SVG odrzucony/);
  }
  const allowed = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">'
    + '<defs><linearGradient id="g"><stop offset="0" stop-color="#123456"/></linearGradient></defs>'
    + '<style>.a{fill:url(#g)}</style><g class="a"><path d="M0 0L10 10"/><text xml:space="preserve">A &amp; B</text></g></svg>';
  assert.ok(validateBrandAsset(raw(allowed), 'logo').ok, 'a typical static logo stays accepted');
});

test('TS and SQL text rules agree: code points for length, C1 controls rejected, link contrast 4.5:1', () => {
  assert.ok(parseBrandConfig(config({ brandName: '🚀'.repeat(80) })).ok, '80 code points fit, as in PostgreSQL length()');
  assert.equal(parseBrandConfig(config({ brandName: '🚀'.repeat(81) })).ok, false);
  assert.match(parseBrandConfig(config({ brandName: 'Acme\u0085' })).error, /niedozwolone znaki/);
  const weakLink = parseBrandConfig(config({ colors: { ...DEFAULT_BRAND_CONFIG.colors, primary: '#888888', onPrimary: '#000000' } }));
  assert.match(weakLink.error, /Kolor główny na tle/);
});

test('object path matches the storage policy shape and refuses traversal', () => {
  const company = '11111111-2222-4333-8444-555555555555', object = '66666666-7777-4888-8999-000000000000';
  assert.equal(brandObjectPath(company, 'logo', object, 'svg'), `${company}/logo/${object}.svg`);
  assert.throws(() => brandObjectPath('../x', 'logo', object, 'svg'));
  assert.throws(() => brandObjectPath(company, 'logo/../favicon', object, 'svg'));
  assert.throws(() => brandObjectPath(company, 'logo', object, 'html'));
});

test('served assets carry sandboxing headers and branding is off on production unless switched on', () => {
  const headers = brandAssetHeaders('image/svg+xml', 10);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.match(headers['content-security-policy'], /default-src 'none'.*sandbox/);
  assert.equal(brandingEnabled({ VERCEL_ENV: 'production' }), false);
  assert.equal(brandingEnabled({ VERCEL_ENV: 'production', WHITE_LABEL_ENABLED: 'true' }), true);
  assert.equal(brandingEnabled({ VERCEL_ENV: 'preview' }), true);
  assert.equal(brandingEnabled({ VERCEL_ENV: 'preview', WHITE_LABEL_ENABLED: 'false' }), false);
  assert.equal(brandingEnabled({}), false);
});
