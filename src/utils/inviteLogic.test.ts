import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizePhone,
  isValidPhone,
  formatPhoneDisplay,
  parseGuestBatchText,
  calculateRealQrCoordinates,
  evaluateCheckinState,
  determineUserRole,
  hasRequiredPermission
} from './inviteLogic';

test('sanitizePhone removes spaces, dashes, parentheses and leading +55', () => {
  assert.equal(sanitizePhone('(11) 99876-5432'), '11998765432');
  assert.equal(sanitizePhone('+55 (21) 98877-6655'), '21988776655');
  assert.equal(sanitizePhone('11 3344-5566'), '1133445566');
  assert.equal(isValidPhone('11998765432'), true);
  assert.equal(isValidPhone('12345'), false);
  assert.equal(formatPhoneDisplay('11998765432'), '(11) 99876-5432');
});

test('parseGuestBatchText parses valid lines and flags malformed or duplicate lines', () => {
  const input = [
    'Ana Clara Mendes, (11) 99876-5432',
    'Bruno Oliveira, 21 98765-4321',
    'Linha Sem Separador 11999999999',
    'Duplicada, 11998765432'
  ].join('\n');

  const result = parseGuestBatchText(input);
  assert.equal(result.validGuests.length, 2);
  assert.deepEqual(result.validGuests[0], {
    name: 'Ana Clara Mendes',
    phone: '11998765432'
  });
  assert.deepEqual(result.validGuests[1], {
    name: 'Bruno Oliveira',
    phone: '21987654321'
  });
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].line, 3);
  assert.equal(result.errors[1].line, 4);
});

test('calculateRealQrCoordinates scales rendered coordinates to natural image dimensions', () => {
  const coords = calculateRealQrCoordinates({
    displayX: 150,
    displayY: 250,
    displaySize: 100,
    renderedWidth: 500,
    renderedHeight: 500,
    naturalWidth: 1000,
    naturalHeight: 1000
  });
  assert.deepEqual(coords, {
    qr_x: 300,
    qr_y: 500,
    qr_size: 200
  });
});

test('evaluateCheckinState handles 404, first check-in success, and duplicate check-in warning', () => {
  const notFound = evaluateCheckinState(null);
  assert.equal(notFound.httpStatus, 404);
  assert.equal(notFound.valid, false);

  const freshGuest = {
    name: 'Ana Clara Mendes',
    phone: '11998765432',
    token: '123e4567-e89b-12d3-a456-426614174000',
    status: 'confirmed' as const,
    checked_in: 0,
    checked_in_at: null
  };
  const firstScan = evaluateCheckinState(freshGuest, '2026-11-02T22:00:00.000Z');
  assert.equal(firstScan.httpStatus, 200);
  assert.equal(firstScan.valid, true);
  assert.equal(firstScan.guestName, 'Ana Clara Mendes');

  const usedGuest = {
    ...freshGuest,
    checked_in: 1,
    checked_in_at: '2026-11-02T22:00:00.000Z'
  };
  const secondScan = evaluateCheckinState(usedGuest);
  assert.equal(secondScan.httpStatus, 200);
  assert.equal(secondScan.valid, false);
  assert.equal(secondScan.alreadyCheckedIn, true);
  assert.equal(secondScan.checkedInAt, '2026-11-02T22:00:00.000Z');
});

test('determineUserRole and hasRequiredPermission correctly separate roles and access', () => {
  const keys = {
    adminPasskey: 'adminMaster2026',
    portariaPasskey: 'portariaEquipe2026'
  };

  assert.equal(determineUserRole('adminMaster2026', keys), 'admin');
  assert.equal(determineUserRole('portariaEquipe2026', keys), 'portaria');
  assert.equal(determineUserRole('senhaIncorreta', keys), null);
  assert.equal(determineUserRole('', keys), null);

  // Admin has access to both admin features and portaria check-in
  assert.equal(hasRequiredPermission('admin', 'admin'), true);
  assert.equal(hasRequiredPermission('admin', 'portaria'), true);

  // Portaria has access to portaria, but NEVER to admin panel
  assert.equal(hasRequiredPermission('portaria', 'portaria'), true);
  assert.equal(hasRequiredPermission('portaria', 'admin'), false);

  // Unauthenticated has access to neither
  assert.equal(hasRequiredPermission(null, 'portaria'), false);
  assert.equal(hasRequiredPermission(null, 'admin'), false);
});

