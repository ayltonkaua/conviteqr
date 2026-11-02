import express from 'express';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import QRCode from 'qrcode';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizePhone,
  isValidPhone,
  formatPhoneDisplay,
  parseGuestBatchText,
  calculateRealQrCoordinates,
  clampQrBoxToBounds,
  evaluateCheckinState,
  determineUserRole,
  hasRequiredPermission
} from './lib/inviteLogic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_ADMIN_PASSKEY = process.env.ADMIN_PASSWORD || 'admin2026';
const DEFAULT_PORTARIA_PASSKEY = process.env.PORTARIA_PASSWORD || 'portaria2026';

// Ensure required runtime directories exist
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');
const generatedDir = path.join(publicDir, 'generated');
const dataDir = path.join(__dirname, 'data');

for (const dir of [publicDir, uploadsDir, generatedDir, dataDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Initialize SQLite database with better-sqlite3 in WAL mode
const dbPath = path.join(dataDir, 'database.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 1. Database Schemas
db.exec(`
  CREATE TABLE IF NOT EXISTS event_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    template_path TEXT NOT NULL,
    qr_x INTEGER NOT NULL DEFAULT 270,
    qr_y INTEGER NOT NULL DEFAULT 670,
    qr_size INTEGER NOT NULL DEFAULT 260
  );

  CREATE TABLE IF NOT EXISTS guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined')),
    checked_in BOOLEAN NOT NULL DEFAULT 0,
    checked_in_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS system_auth (
    role TEXT PRIMARY KEY,
    passkey TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Clean any previous test/mock data from development runs
try {
  db.prepare(`
    DELETE FROM guests 
    WHERE phone IN ('11998765432', '11987654321', '21991234567', '31997651234', '41996543210')
  `).run();
} catch {
  // ignore
}

// Initialize system auth keys in database if not present
function initSystemAuth() {
  const insertAuthStmt = db.prepare(`
    INSERT INTO system_auth (role, passkey) 
    VALUES (?, ?) 
    ON CONFLICT(role) DO NOTHING
  `);
  insertAuthStmt.run('admin', DEFAULT_ADMIN_PASSKEY);
  insertAuthStmt.run('portaria', DEFAULT_PORTARIA_PASSKEY);
}
initSystemAuth();

function getSystemAuthKeys() {
  const rows = db.prepare('SELECT role, passkey FROM system_auth').all();
  const map = {};
  for (const r of rows) {
    map[r.role] = r.passkey;
  }
  return {
    adminPasskey: map['admin'] || DEFAULT_ADMIN_PASSKEY,
    portariaPasskey: map['portaria'] || DEFAULT_PORTARIA_PASSKEY
  };
}

// Create a high-resolution default invitation template using sharp if not already present
const defaultTemplateFilename = 'default-template.png';
const defaultTemplateDiskPath = path.join(uploadsDir, defaultTemplateFilename);
const defaultTemplatePublicPath = `/uploads/${defaultTemplateFilename}`;

async function ensureDefaultTemplateImage() {
  if (fs.existsSync(defaultTemplateDiskPath)) {
    return;
  }

  const width = 800;
  const height = 1120;
  const svgTemplate = `
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0f172a" />
        <stop offset="50%" stop-color="#1e293b" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
      <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#d4af37" />
        <stop offset="50%" stop-color="#f3e5ab" />
        <stop offset="100%" stop-color="#aa7c11" />
      </linearGradient>
    </defs>

    <!-- Background -->
    <rect width="${width}" height="${height}" fill="url(#bgGrad)" />

    <!-- Architectural Border Frame -->
    <rect x="36" y="36" width="${width - 72}" height="${height - 72}" rx="16" fill="none" stroke="url(#goldGrad)" stroke-width="2" stroke-opacity="0.65" />
    <rect x="52" y="52" width="${width - 104}" height="${height - 104}" rx="10" fill="none" stroke="#94a3b8" stroke-width="1" stroke-opacity="0.25" />

    <!-- Subtle Geometric Corner Accents -->
    <circle cx="52" cy="52" r="4" fill="#d4af37" />
    <circle cx="${width - 52}" cy="52" r="4" fill="#d4af37" />
    <circle cx="52" cy="${height - 52}" r="4" fill="#d4af37" />
    <circle cx="${width - 52}" cy="${height - 52}" r="4" fill="#d4af37" />

    <!-- Top Kicker -->
    <text x="400" y="145" text-anchor="middle" fill="#eab308" font-family="sans-serif" font-size="15" font-weight="600" letter-spacing="6">
      CONVITE OFICIAL EXCLUSIVO
    </text>
    <line x1="310" y1="170" x2="490" y2="170" stroke="url(#goldGrad)" stroke-width="1.5" opacity="0.7" />

    <!-- Main Event Title -->
    <text x="400" y="250" text-anchor="middle" fill="#f8fafc" font-family="Georgia, serif" font-size="48" font-weight="700">
      Noite de Gala
    </text>
    <text x="400" y="310" text-anchor="middle" fill="url(#goldGrad)" font-family="Georgia, serif" font-size="42" font-weight="700">
      &amp; Summit 2026
    </text>

    <!-- Subtitle -->
    <text x="400" y="370" text-anchor="middle" fill="#cbd5e1" font-family="sans-serif" font-size="18" font-weight="400">
      Celebração anual de liderança, gastronomia e conexões
    </text>

    <!-- Event Details Card -->
    <rect x="120" y="420" width="560" height="175" rx="12" fill="#0f172a" fill-opacity="0.55" stroke="#334155" stroke-width="1.5" />

    <text x="235" y="475" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="13" font-weight="600" letter-spacing="2">
      DATA E HORÁRIO
    </text>
    <text x="235" y="510" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-size="22" font-weight="700">
      28 NOV · 20h00
    </text>
    <text x="235" y="540" text-anchor="middle" fill="#cbd5e1" font-family="sans-serif" font-size="14">
      Sábado · Recepção 19h30
    </text>

    <line x1="400" y1="445" x2="400" y2="570" stroke="#334155" stroke-width="1.5" />

    <text x="565" y="475" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="13" font-weight="600" letter-spacing="2">
      LOCALIZAÇÃO
    </text>
    <text x="565" y="510" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-size="22" font-weight="700">
      Espaço Villa Lobos
    </text>
    <text x="565" y="540" text-anchor="middle" fill="#cbd5e1" font-family="sans-serif" font-size="14">
      Av. Gonçalo Madeira, São Paulo
    </text>

    <!-- QR Code Placeholder Frame -->
    <rect x="258" y="658" width="284" height="284" rx="16" fill="#ffffff" fill-opacity="0.06" stroke="url(#goldGrad)" stroke-width="2" stroke-dasharray="8 6" />
    <text x="400" y="640" text-anchor="middle" fill="#e2e8f0" font-family="sans-serif" font-size="14" font-weight="600" letter-spacing="2">
      CREDENCIAL DE ACESSO INDIVIDUAL
    </text>

    <!-- Footer instructions -->
    <text x="400" y="995" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="15">
      Apresente o QR Code acima na portaria do evento (impresso ou no celular)
    </text>
    <text x="400" y="1025" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="13">
      Traje: Passeio Completo · Convite pessoal e intransferível
    </text>
  </svg>`;

  await sharp(Buffer.from(svgTemplate))
    .png({ quality: 95 })
    .toFile(defaultTemplateDiskPath);
}

function ensureEventConfig() {
  const existingConfig = db.prepare('SELECT * FROM event_config WHERE id = 1').get();
  if (!existingConfig) {
    db.prepare(`
      INSERT INTO event_config (id, template_path, qr_x, qr_y, qr_size)
      VALUES (1, ?, 270, 670, 260)
    `).run(defaultTemplatePublicPath);
  }
}

// Resolve public template path to disk file path safely
function resolveTemplateDiskPath(templatePublicPath) {
  if (!templatePublicPath) return defaultTemplateDiskPath;
  const relativeCleaned = templatePublicPath.replace(/^\/+/, '');
  const candidate = path.join(publicDir, relativeCleaned);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return defaultTemplateDiskPath;
}

// Generate stamped QR invitation image with sharp
async function generateStampedInviteBuffer(token) {
  const config = db.prepare('SELECT * FROM event_config WHERE id = 1').get() || {
    template_path: defaultTemplatePublicPath,
    qr_x: 270,
    qr_y: 670,
    qr_size: 260
  };

  const templateDiskPath = resolveTemplateDiskPath(config.template_path);
  const metadata = await sharp(templateDiskPath).metadata();
  const imageWidth = metadata.width || 800;
  const imageHeight = metadata.height || 1120;

  const { left, top, size } = clampQrBoxToBounds({
    qr_x: config.qr_x,
    qr_y: config.qr_y,
    qr_size: config.qr_size,
    imageWidth,
    imageHeight
  });

  const qrBuffer = await QRCode.toBuffer(token, {
    type: 'png',
    width: size,
    margin: 2,
    color: {
      dark: '#0f172a',
      light: '#ffffff'
    },
    errorCorrectionLevel: 'H'
  });

  const resizedQrBuffer = await sharp(qrBuffer)
    .resize(size, size, { fit: 'fill' })
    .png()
    .toBuffer();

  const finalImageBuffer = await sharp(templateDiskPath)
    .composite([
      {
        input: resizedQrBuffer,
        left,
        top
      }
    ])
    .png({ quality: 92 })
    .toBuffer();

  return finalImageBuffer;
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configure Multer for template image uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
    cb(null, `template-${Date.now()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMime = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowedMime.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de imagem PNG ou JPG são permitidos.'));
    }
  }
});

// Helper to extract access token from headers
function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const adminKeyHeader = req.headers['x-admin-key'] || '';
  const portariaKeyHeader = req.headers['x-portaria-key'] || '';
  const queryKey = req.query?.key || '';

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (authHeader) return String(authHeader).trim();
  if (adminKeyHeader) return String(adminKeyHeader).trim();
  if (portariaKeyHeader) return String(portariaKeyHeader).trim();
  if (queryKey) return String(queryKey).trim();
  return '';
}

// Middleware: Requires full Administrator permissions
function requireAdminAuth(req, res, next) {
  const token = extractToken(req);
  const keys = getSystemAuthKeys();
  const role = determineUserRole(token, keys);

  if (!hasRequiredPermission(role, 'admin')) {
    return res.status(401).json({
      error: 'Não autorizado. Credencial de Administrador do evento requerida.'
    });
  }

  req.userRole = role;
  next();
}

// Middleware: Requires Portaria or Administrator permissions
function requirePortariaAuth(req, res, next) {
  const token = extractToken(req);
  const keys = getSystemAuthKeys();
  const role = determineUserRole(token, keys);

  if (!hasRequiredPermission(role, 'portaria')) {
    return res.status(401).json({
      error: 'Não autorizado. Credencial de Portaria ou Administrador requerida.'
    });
  }

  req.userRole = role;
  next();
}

// ============================================================================
// AUTH & PERMISSIONS VERIFICATION ROUTES
// ============================================================================

// POST /api/auth/verify - Verify role for given passkey
app.post('/api/auth/verify', (req, res) => {
  const token = String(req.body.key || extractToken(req) || '').trim();
  const keys = getSystemAuthKeys();
  const role = determineUserRole(token, keys);

  if (!role) {
    return res.status(401).json({
      valid: false,
      role: null,
      message: 'Chave de acesso inválida ou não informada.'
    });
  }

  return res.json({
    valid: true,
    role,
    message: role === 'admin' ? 'Acesso total de Administrador liberado.' : 'Acesso operacional de Portaria liberado.'
  });
});

// GET /api/admin/keys - (Admin only) Retrieve active passkeys to share with reception staff
app.get('/api/admin/keys', requireAdminAuth, (_req, res) => {
  const keys = getSystemAuthKeys();
  res.json({
    adminPasskey: keys.adminPasskey,
    portariaPasskey: keys.portariaPasskey
  });
});

// POST /api/admin/keys - (Admin only) Update portaria or admin passkey
app.post('/api/admin/keys', requireAdminAuth, (req, res) => {
  try {
    const { portariaPasskey, adminPasskey } = req.body;
    const updateStmt = db.prepare(`
      INSERT INTO system_auth (role, passkey, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(role) DO UPDATE SET
        passkey = excluded.passkey,
        updated_at = CURRENT_TIMESTAMP
    `);

    if (portariaPasskey && typeof portariaPasskey === 'string' && portariaPasskey.trim().length >= 4) {
      updateStmt.run('portaria', portariaPasskey.trim());
    }

    if (adminPasskey && typeof adminPasskey === 'string' && adminPasskey.trim().length >= 4) {
      updateStmt.run('admin', adminPasskey.trim());
    }

    const updated = getSystemAuthKeys();
    res.json({
      message: 'Chaves de acesso atualizadas com sucesso.',
      keys: updated
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar chaves de acesso.', details: err.message });
  }
});

// ============================================================================
// ADMIN ROUTES (EVENT CONFIG, GUESTS CRUD, BATCH IMPORT)
// ============================================================================

app.post('/api/admin/verify', requireAdminAuth, (_req, res) => {
  res.json({ ok: true, message: 'Autenticado com sucesso como Administrador.' });
});

app.get('/api/admin/config', requireAdminAuth, async (_req, res) => {
  try {
    const config = db.prepare('SELECT * FROM event_config WHERE id = 1').get();
    const diskPath = resolveTemplateDiskPath(config?.template_path);
    const metadata = await sharp(diskPath).metadata();
    res.json({
      config: {
        ...config,
        naturalWidth: metadata.width || 800,
        naturalHeight: metadata.height || 1120
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar configuração do evento.', details: err.message });
  }
});

// POST /api/admin/template - Upload new background image and/or save QR coordinates
app.post('/api/admin/template', requireAdminAuth, (req, res, next) => {
  upload.single('template')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Erro no upload da imagem.' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const currentConfig = db.prepare('SELECT * FROM event_config WHERE id = 1').get();
    let templatePath = currentConfig ? currentConfig.template_path : defaultTemplatePublicPath;

    if (req.file) {
      templatePath = `/uploads/${req.file.filename}`;
    }

    const diskPath = resolveTemplateDiskPath(templatePath);
    const metadata = await sharp(diskPath).metadata();
    const naturalWidth = metadata.width || 800;
    const naturalHeight = metadata.height || 1120;

    let qr_x = currentConfig ? currentConfig.qr_x : 270;
    let qr_y = currentConfig ? currentConfig.qr_y : 670;
    let qr_size = currentConfig ? currentConfig.qr_size : 260;

    if (
      req.body.displayX !== undefined &&
      req.body.displayY !== undefined &&
      req.body.displaySize !== undefined &&
      req.body.renderedWidth &&
      req.body.renderedHeight
    ) {
      const calculated = calculateRealQrCoordinates({
        displayX: Number(req.body.displayX),
        displayY: Number(req.body.displayY),
        displaySize: Number(req.body.displaySize),
        renderedWidth: Number(req.body.renderedWidth),
        renderedHeight: Number(req.body.renderedHeight),
        naturalWidth,
        naturalHeight
      });
      qr_x = calculated.qr_x;
      qr_y = calculated.qr_y;
      qr_size = calculated.qr_size;
    } else if (
      req.body.qr_x !== undefined &&
      req.body.qr_y !== undefined &&
      req.body.qr_size !== undefined
    ) {
      const clamped = clampQrBoxToBounds({
        qr_x: Number(req.body.qr_x),
        qr_y: Number(req.body.qr_y),
        qr_size: Number(req.body.qr_size),
        imageWidth: naturalWidth,
        imageHeight: naturalHeight
      });
      qr_x = clamped.left;
      qr_y = clamped.top;
      qr_size = clamped.size;
    }

    db.prepare(`
      INSERT INTO event_config (id, template_path, qr_x, qr_y, qr_size)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template_path = excluded.template_path,
        qr_x = excluded.qr_x,
        qr_y = excluded.qr_y,
        qr_size = excluded.qr_size
    `).run(templatePath, qr_x, qr_y, qr_size);

    // Clear cached generated invites so new coordinates take effect
    for (const file of fs.readdirSync(generatedDir)) {
      if (file.endsWith('.png')) {
        try {
          fs.unlinkSync(path.join(generatedDir, file));
        } catch {
          // ignore
        }
      }
    }

    res.json({
      message: 'Configuração do convite salva com sucesso!',
      config: {
        id: 1,
        template_path: templatePath,
        qr_x,
        qr_y,
        qr_size,
        naturalWidth,
        naturalHeight
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao salvar o template do convite.', details: err.message });
  }
});

// GET /api/admin/guests - List all guests and summary statistics
app.get('/api/admin/guests', requireAdminAuth, (_req, res) => {
  try {
    const guests = db.prepare('SELECT * FROM guests ORDER BY id DESC').all();
    const stats = {
      total: guests.length,
      confirmed: guests.filter((g) => g.status === 'confirmed').length,
      pending: guests.filter((g) => g.status === 'pending').length,
      declined: guests.filter((g) => g.status === 'declined').length,
      checkedIn: guests.filter((g) => Number(g.checked_in) === 1).length
    };
    res.json({ guests, stats });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar convidados.', details: err.message });
  }
});

// POST /api/admin/guests/import - Batch import "Nome, Telefone"
app.post('/api/admin/guests/import', requireAdminAuth, (req, res) => {
  try {
    const rawText = req.body.rawText || req.body.guestsText || '';
    if (!rawText || !String(rawText).trim()) {
      return res.status(400).json({
        error: 'Informe ao menos uma linha no formato "Nome, Telefone".'
      });
    }

    const { validGuests, errors } = parseGuestBatchText(String(rawText));

    if (validGuests.length === 0 && errors.length > 0) {
      return res.status(400).json({
        error: 'Nenhum convidado válido encontrado no lote enviado.',
        errors
      });
    }

    let insertedCount = 0;
    let updatedCount = 0;

    const findByPhoneStmt = db.prepare('SELECT id, name FROM guests WHERE phone = ?');
    const insertGuestStmt = db.prepare(`
      INSERT INTO guests (name, phone, token, status, checked_in)
      VALUES (?, ?, ?, 'pending', 0)
    `);
    const updateGuestNameStmt = db.prepare(`
      UPDATE guests SET name = ? WHERE phone = ?
    `);

    const processBatch = db.transaction((items) => {
      for (const item of items) {
        const existing = findByPhoneStmt.get(item.phone);
        if (existing) {
          updateGuestNameStmt.run(item.name, item.phone);
          updatedCount++;
        } else {
          const token = crypto.randomUUID();
          insertGuestStmt.run(item.name, item.phone, token);
          insertedCount++;
        }
      }
    });

    processBatch(validGuests);

    const guests = db.prepare('SELECT * FROM guests ORDER BY id DESC').all();
    res.json({
      message: `Importação concluída: ${insertedCount} novo(s), ${updatedCount} atualizado(s).`,
      insertedCount,
      updatedCount,
      errors,
      guests
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao importar lista de convidados.', details: err.message });
  }
});

// DELETE /api/admin/guests/:id
app.delete('/api/admin/guests/:id', requireAdminAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    const info = db.prepare('DELETE FROM guests WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Convidado não encontrado.' });
    }
    res.json({ message: 'Convidado removido com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover convidado.', details: err.message });
  }
});

// POST /api/admin/guests/:id/reset-checkin
app.post('/api/admin/guests/:id/reset-checkin', requireAdminAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    const info = db
      .prepare('UPDATE guests SET checked_in = 0, checked_in_at = NULL WHERE id = ?')
      .run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Convidado não encontrado.' });
    }
    res.json({ message: 'Status de check-in redefinido com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao redefinir check-in.', details: err.message });
  }
});

// ============================================================================
// GUEST ROUTES (/index.html - STRICTLY PRIVATE & PRODUCTION-READY)
// ============================================================================

function handleGuestSearch(rawPhone, res) {
  const phone = sanitizePhone(rawPhone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({
      error: 'Digite um número de telefone válido com DDD (10 ou 11 dígitos).'
    });
  }

  const guest = db.prepare('SELECT * FROM guests WHERE phone = ?').get(phone);
  if (!guest) {
    return res.status(404).json({
      error: 'Não encontramos nenhum convite vinculado a este telefone. Verifique o número digitado ou fale com a organização.'
    });
  }

  return res.json({
    guest: {
      id: guest.id,
      name: guest.name,
      phone: guest.phone,
      formattedPhone: formatPhoneDisplay(guest.phone),
      token: guest.token,
      status: guest.status,
      checked_in: Boolean(guest.checked_in),
      checked_in_at: guest.checked_in_at,
      inviteUrl: guest.status === 'confirmed' ? `/api/guest/invite/${guest.token}?t=${Date.now()}` : null,
      downloadUrl: guest.status === 'confirmed' ? `/api/guest/invite/${guest.token}/download` : null
    }
  });
}

app.get('/api/guest/search', (req, res) => {
  handleGuestSearch(req.query.phone, res);
});

app.post('/api/guest/search', (req, res) => {
  handleGuestSearch(req.body.phone, res);
});

// POST /api/guest/rsvp - Confirm or Decline attendance & generate QR invite if confirmed
app.post('/api/guest/rsvp', async (req, res) => {
  try {
    const phone = sanitizePhone(req.body.phone);
    const status = req.body.status;

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Número de telefone inválido.' });
    }

    if (!['confirmed', 'declined'].includes(status)) {
      return res.status(400).json({ error: 'Status de confirmação inválido.' });
    }

    const guest = db.prepare('SELECT * FROM guests WHERE phone = ?').get(phone);
    if (!guest) {
      return res.status(404).json({ error: 'Convidado não encontrado para este telefone.' });
    }

    db.prepare('UPDATE guests SET status = ? WHERE id = ?').run(status, guest.id);
    const updatedGuest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guest.id);

    let inviteUrl = null;
    let downloadUrl = null;

    if (status === 'confirmed') {
      const inviteBuffer = await generateStampedInviteBuffer(updatedGuest.token);
      const outputFilename = `convite-${updatedGuest.token}.png`;
      const outputDiskPath = path.join(generatedDir, outputFilename);
      fs.writeFileSync(outputDiskPath, inviteBuffer);

      inviteUrl = `/generated/${outputFilename}?t=${Date.now()}`;
      downloadUrl = `/api/guest/invite/${updatedGuest.token}/download`;
    }

    res.json({
      message:
        status === 'confirmed'
          ? 'Presença confirmada! Seu convite personalizado com QR Code foi gerado.'
          : 'Sua resposta foi registrada. Sentiremos sua falta!',
      guest: {
        id: updatedGuest.id,
        name: updatedGuest.name,
        phone: updatedGuest.phone,
        formattedPhone: formatPhoneDisplay(updatedGuest.phone),
        token: updatedGuest.token,
        status: updatedGuest.status,
        checked_in: Boolean(updatedGuest.checked_in),
        checked_in_at: updatedGuest.checked_in_at,
        inviteUrl,
        downloadUrl
      }
    });
  } catch (err) {
    res.status(500).json({
      error: 'Erro ao processar sua confirmação de presença.',
      details: err.message
    });
  }
});

// GET /api/guest/invite/:token - Render stamped invitation PNG
app.get('/api/guest/invite/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const guest = db.prepare('SELECT * FROM guests WHERE token = ?').get(token);
    if (!guest) {
      return res.status(404).json({ error: 'Convite não encontrado.' });
    }

    const buffer = await generateStampedInviteBuffer(guest.token);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar imagem do convite.', details: err.message });
  }
});

// GET /api/guest/invite/:token/download - Download stamped invitation PNG
app.get('/api/guest/invite/:token/download', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const guest = db.prepare('SELECT * FROM guests WHERE token = ?').get(token);
    if (!guest) {
      return res.status(404).json({ error: 'Convite não encontrado.' });
    }

    const buffer = await generateStampedInviteBuffer(guest.token);
    const safeSlug = guest.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="convite-${safeSlug || 'evento'}.png"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao baixar convite.', details: err.message });
  }
});

// ============================================================================
// PORTARIA / CHECK-IN ROUTES (PROTECTED BY PORTARIA OR ADMIN KEY)
// ============================================================================

// GET /api/checkin/overview - Real-time gate metrics & real entry history
app.get('/api/checkin/overview', requirePortariaAuth, (_req, res) => {
  try {
    const guests = db.prepare(`
      SELECT id, name, phone, token, status, checked_in, checked_in_at 
      FROM guests 
      ORDER BY checked_in_at DESC, id DESC
    `).all();

    const stats = {
      total: guests.length,
      confirmed: guests.filter((g) => g.status === 'confirmed').length,
      checkedIn: guests.filter((g) => Number(g.checked_in) === 1).length,
      remainingConfirmed: guests.filter((g) => g.status === 'confirmed' && Number(g.checked_in) === 0).length
    };

    const recentCheckins = guests
      .filter((g) => Number(g.checked_in) === 1)
      .slice(0, 15)
      .map((g) => ({
        id: g.id,
        name: g.name,
        phone: formatPhoneDisplay(g.phone),
        token: g.token,
        checkedInAt: g.checked_in_at
      }));

    res.json({ stats, recentCheckins });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar resumo da portaria.' });
  }
});

// POST /api/checkin - Validate ticket & register entry (Portaria or Admin permission required)
app.post('/api/checkin', requirePortariaAuth, (req, res) => {
  try {
    const rawToken = String(req.body.token || '').trim();
    if (!rawToken) {
      return res.status(400).json({
        valid: false,
        code: 'EMPTY_TOKEN',
        message: 'Informe ou escaneie um token de QR Code para validar.'
      });
    }

    const guest = db.prepare('SELECT * FROM guests WHERE token = ?').get(rawToken);
    const nowFormatted = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const evaluation = evaluateCheckinState(guest, nowFormatted);

    if (evaluation.code === 'CHECKIN_SUCCESS') {
      db.prepare(`
        UPDATE guests
        SET checked_in = 1,
            checked_in_at = ?,
            status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
        WHERE id = ?
      `).run(nowFormatted, guest.id);
    }

    return res.status(evaluation.httpStatus).json(evaluation);
  } catch (err) {
    return res.status(500).json({
      valid: false,
      code: 'SERVER_ERROR',
      message: 'Erro interno ao processar leitura na portaria.',
      details: err.message
    });
  }
});

// Serve static frontend files from /public
app.use(express.static(publicDir));

// Clean URL route aliases
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/portaria', (_req, res) => {
  res.sendFile(path.join(publicDir, 'portaria.html'));
});

// Initialize default event template & start Express server
await ensureDefaultTemplateImage();
ensureEventConfig();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ConviteQR Produção] Servidor rodando em http://0.0.0.0:${PORT}`);
});
