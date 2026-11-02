export interface GuestEntry {
  name: string;
  phone: string;
}

export interface BatchParseError {
  line: number;
  raw: string;
  reason: string;
}

export interface BatchParseResult {
  validGuests: GuestEntry[];
  errors: BatchParseError[];
}

export interface ProportionalInput {
  displayX: number;
  displayY: number;
  displaySize: number;
  renderedWidth: number;
  renderedHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface QrCoords {
  qr_x: number;
  qr_y: number;
  qr_size: number;
}

export interface GuestRecord {
  id?: number;
  name: string;
  phone: string;
  token: string;
  status: 'pending' | 'confirmed' | 'declined';
  checked_in: number | boolean;
  checked_in_at?: string | null;
}

export function sanitizePhone(input: string | number | null | undefined): string {
  if (typeof input !== 'string' && typeof input !== 'number') {
    return '';
  }
  let digits = String(input).replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    digits = digits.slice(2);
  }
  return digits;
}

export function isValidPhone(digits: string): boolean {
  const clean = sanitizePhone(digits);
  return clean.length >= 10 && clean.length <= 11;
}

export function formatPhoneDisplay(input: string): string {
  const digits = sanitizePhone(input);
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

export function parseGuestBatchText(rawText: string): BatchParseResult {
  if (!rawText || typeof rawText !== 'string') {
    return { validGuests: [], errors: [] };
  }

  const lines = rawText.split(/\r?\n/);
  const validGuests: GuestEntry[] = [];
  const errors: BatchParseError[] = [];
  const seenPhones = new Set<string>();

  lines.forEach((rawLine, index) => {
    const lineNum = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

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
}: ProportionalInput): QrCoords {
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

export function evaluateCheckinState(
  guest: GuestRecord | null | undefined,
  nowIso: string = new Date().toISOString()
) {
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

export type AppRole = 'admin' | 'portaria' | null;

export interface AuthKeys {
  adminPasskey: string;
  portariaPasskey: string;
}

export function determineUserRole(
  providedKey: string | null | undefined,
  { adminPasskey, portariaPasskey }: AuthKeys
): AppRole {
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

export function hasRequiredPermission(userRole: AppRole, requiredRole: 'admin' | 'portaria'): boolean {
  if (userRole === 'admin') {
    return true;
  }
  if (userRole === 'portaria' && requiredRole === 'portaria') {
    return true;
  }
  return false;
}

