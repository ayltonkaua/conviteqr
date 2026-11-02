/**
 * Pure domain logic for phone sanitization, batch guest parsing,
 * proportional QR coordinate math, and check-in state evaluation.
 */

export function sanitizePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') {
    return '';
  }
  let digits = String(input).replace(/\D/g, '');
  // If user pasted +55 (Brazil country code) with 12 or 13 digits, strip leading 55
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    digits = digits.slice(2);
  }
  return digits;
}

export function isValidPhone(digits) {
  const clean = sanitizePhone(digits);
  return clean.length >= 10 && clean.length <= 11;
}

export function formatPhoneDisplay(input) {
  const digits = sanitizePhone(input);
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

export function parseGuestBatchText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { validGuests: [], errors: [] };
  }

  const lines = rawText.split(/\r?\n/);
  const validGuests = [];
  const errors = [];
  const seenPhones = new Set();

  lines.forEach((rawLine, index) => {
    const lineNum = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    // Split by last comma or semicolon so names with commas still work reasonably
    const separatorMatch = trimmed.match(/[,;\t]/);
    if (!separatorMatch) {
      errors.push({
        line: lineNum,
        raw: trimmed,
        reason: 'Formato inválido. Use "Nome, Telefone".'
      });
      return;
    }

    const lastCommaIdx = Math.max(
      trimmed.lastIndexOf(','),
      trimmed.lastIndexOf(';'),
      trimmed.lastIndexOf('\t')
    );
    const name = trimmed.slice(0, lastCommaIdx).trim();
    const rawPhone = trimmed.slice(lastCommaIdx + 1).trim();
    const phone = sanitizePhone(rawPhone);

    if (!name || name.length < 2) {
      errors.push({
        line: lineNum,
        raw: trimmed,
        reason: 'Nome do convidado ausente ou muito curto.'
      });
      return;
    }

    if (!isValidPhone(phone)) {
      errors.push({
        line: lineNum,
        raw: trimmed,
        reason: `Telefone inválido (${rawPhone}). Informe DDD + número (10 ou 11 dígitos).`
      });
      return;
    }

    if (seenPhones.has(phone)) {
      errors.push({
        line: lineNum,
        raw: trimmed,
        reason: `Telefone duplicado no mesmo lote (${formatPhoneDisplay(phone)}).`
      });
      return;
    }

    seenPhones.add(phone);
    validGuests.push({ name, phone });
  });

  return { validGuests, errors };
}

export function calculateRealQrCoordinates({
  displayX,
  displayY,
  displaySize,
  renderedWidth,
  renderedHeight,
  naturalWidth,
  naturalHeight
}) {
  if (
    !renderedWidth ||
    !renderedHeight ||
    !naturalWidth ||
    !naturalHeight ||
    renderedWidth <= 0 ||
    renderedHeight <= 0 ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    throw new Error('Dimensões inválidas para cálculo proporcional do QR Code.');
  }

  const scaleX = naturalWidth / renderedWidth;
  const scaleY = naturalHeight / renderedHeight;
  const scaleAvg = (scaleX + scaleY) / 2;

  const rawSize = Math.round(Number(displaySize) * scaleAvg);
  const maxAllowedSize = Math.min(naturalWidth, naturalHeight);
  const qr_size = Math.max(40, Math.min(rawSize, maxAllowedSize));

  const rawX = Math.round(Number(displayX) * scaleX);
  const rawY = Math.round(Number(displayY) * scaleY);

  const qr_x = Math.max(0, Math.min(rawX, naturalWidth - qr_size));
  const qr_y = Math.max(0, Math.min(rawY, naturalHeight - qr_size));

  return { qr_x, qr_y, qr_size };
}

export function clampQrBoxToBounds({ qr_x, qr_y, qr_size, imageWidth, imageHeight }) {
  const safeWidth = Math.max(60, Number(imageWidth) || 800);
  const safeHeight = Math.max(60, Number(imageHeight) || 1000);
  const maxDim = Math.min(safeWidth, safeHeight);
  const size = Math.max(40, Math.min(Math.round(Number(qr_size) || 200), maxDim));
  const left = Math.max(0, Math.min(Math.round(Number(qr_x) || 0), safeWidth - size));
  const top = Math.max(0, Math.min(Math.round(Number(qr_y) || 0), safeHeight - size));
  return { left, top, size };
}

export function evaluateCheckinState(guest, nowIso = new Date().toISOString()) {
  if (!guest) {
    return {
      httpStatus: 404,
      valid: false,
      code: 'INVALID_TOKEN',
      message: 'Convite inválido ou token não encontrado no sistema.'
    };
  }

  if (Number(guest.checked_in) === 1) {
    return {
      httpStatus: 200,
      valid: false,
      alreadyCheckedIn: true,
      code: 'ALREADY_CHECKED_IN',
      message: 'Atenção: Este convite já foi utilizado anteriormente.',
      guestName: guest.name,
      phone: formatPhoneDisplay(guest.phone),
      status: guest.status,
      checkedInAt: guest.checked_in_at
    };
  }

  return {
    httpStatus: 200,
    valid: true,
    alreadyCheckedIn: false,
    code: 'CHECKIN_SUCCESS',
    message: 'Acesso liberado! Check-in realizado com sucesso.',
    guestName: guest.name,
    phone: formatPhoneDisplay(guest.phone),
    status: guest.status,
    checkedInAt: nowIso
  };
}

export function determineUserRole(providedKey, { adminPasskey, portariaPasskey }) {
  if (!providedKey || typeof providedKey !== 'string') {
    return null;
  }
  const clean = providedKey.trim();
  if (adminPasskey && clean === String(adminPasskey).trim()) {
    return 'admin';
  }
  if (portariaPasskey && clean === String(portariaPasskey).trim()) {
    return 'portaria';
  }
  return null;
}

export function hasRequiredPermission(userRole, requiredRole) {
  if (userRole === 'admin') {
    return true; // Admin has access to both admin and portaria capabilities
  }
  if (userRole === 'portaria' && requiredRole === 'portaria') {
    return true;
  }
  return false;
}

