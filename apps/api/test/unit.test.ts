import { describe, it, expect } from 'vitest';
import { computeAuditHash, type AuditEntry } from '../src/lib/audit';
import { encryptField, decryptField, blindIndex, normalize, maskId, maskPhone, hmacToken } from '../src/lib/crypto';
import { generateTotpSecret, totpCode, verifyTotp } from '../src/lib/totp';

describe('crypto primitives', () => {
  it('round-trips AES-256-GCM and binds ciphertext to its AAD', () => {
    const cipher = encryptField('1234567890', 'patients.national_id_enc:abc')!;
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(cipher).not.toContain('1234567890');
    expect(decryptField(cipher, 'patients.national_id_enc:abc')).toBe('1234567890');
    expect(() => decryptField(cipher, 'patients.phone_enc:abc')).toThrow();
  });

  it('produces deterministic blind indexes that survive Arabic normalisation', () => {
    expect(blindIndex('أحمد')).toBe(blindIndex(' احمد '));
    expect(blindIndex('1000000001')).not.toBe(blindIndex('1000000002'));
    expect(blindIndex('1000000001')).not.toContain('1000000001');
  });

  it('normalises Arabic text for search', () => {
    expect(normalize('  مُحَمَّد   العَتيبي ')).toBe('محمد العتيبي');
  });

  it('masks identifiers without leaking the original', () => {
    expect(maskId('1000000001')).toBe('******0001');
    expect(maskPhone('0501234567')).toBe('050****567');
  });

  it('obfuscates session tokens with an HMAC (no raw token at rest)', () => {
    expect(hmacToken('token')).toHaveLength(64);
    expect(hmacToken('token')).not.toBe(hmacToken('token2'));
  });
});

describe('TOTP (RFC 6238)', () => {
  it('accepts the current code and rejects unrelated/expired codes', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, now))).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now))).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 10 * 30_000))).toBe(false);
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(totpCode(secret, now)).toMatch(/^\d{6}$/);
  });
});

describe('audit hash chain', () => {
  const entry: AuditEntry = {
    facilityId: 'f1',
    actorUserId: 'u1',
    actorRole: 'physician',
    action: 'patient.create',
    entityType: 'patient',
    entityId: 'p1',
    patientId: 'p1',
    detail: { mrn: 'MRN-0001' },
    ip: '127.0.0.1',
  };

  it('is deterministic and order-sensitive', () => {
    const a = computeAuditHash(entry, '2026-01-01T00:00:00.000Z', '0'.repeat(64));
    const b = computeAuditHash(entry, '2026-01-01T00:00:00.000Z', '0'.repeat(64));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    const c = computeAuditHash(entry, '2026-01-01T00:00:00.000Z', 'a'.repeat(64));
    expect(c).not.toBe(a);
  });

  it('changes when any audited field changes', () => {
    const base = computeAuditHash(entry, '2026-01-01T00:00:00.000Z', '0'.repeat(64));
    const tampered = computeAuditHash({ ...entry, detail: { mrn: 'MRN-9999' } }, '2026-01-01T00:00:00.000Z', '0'.repeat(64));
    expect(tampered).not.toBe(base);
  });
});

describe('CSV export hardening', () => {
  it('neutralises spreadsheet formula injection and quotes special characters', async () => {
    const { csvCell, toCsv } = await import('../src/modules/reports/routes');
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('عادي')).toBe('عادي');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    const csv = toCsv([{ name: '=1+1', visits: 3 }], [
      { key: 'name', ar: 'الاسم' },
      { key: 'visits', ar: 'الزيارات' },
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain(`'=1+1`);
    expect(csv).toContain('الاسم,الزيارات');
  });
});
