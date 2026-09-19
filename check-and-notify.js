// Runs once a day (via GitHub Actions). Reads the Libro de Fiado data from
// Google Drive using a service account, figures out who is due to be
// collected today or overdue, and sends a push notification to every
// device that turned on notifications in the app.
"use strict";

const { google } = require("googleapis");
const webpush = require("web-push");

const FOLDER_NAME = "Libro de Fiado";
const DATA_FILE = "datos.json";
const SUBS_FILE = "subs.json";

function todayInBogota() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

function diffDays(isoA, isoB) {
  const [ay, am, ad] = isoA.split("-").map(Number);
  const [by, bm, bd] = isoB.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((a - b) / 86400000);
}

async function main() {
  const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!saKeyRaw || !vapidPublic || !vapidPrivate) {
    throw new Error("Faltan variables de entorno (GOOGLE_SERVICE_ACCOUNT_KEY / VAPID keys).");
  }
  const credentials = JSON.parse(saKeyRaw);

  webpush.setVapidDetails("mailto:no-reply@example.com", vapidPublic, vapidPrivate);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  const drive = google.drive({ version: "v3", auth });

  async function findFile(name, parentQuery) {
    const q = `name='${name}' and trashed=false` + (parentQuery ? ` and ${parentQuery}` : "");
    const res = await drive.files.list({ q, fields: "files(id,name)" });
    return (res.data.files && res.data.files[0]) || null;
  }

  const folder = await findFile(FOLDER_NAME, "mimeType='application/vnd.google-apps.folder'");
  if (!folder) {
    console.log("No se encontró la carpeta 'Libro de Fiado' compartida con la cuenta de servicio. Nada que hacer.");
    return;
  }

  const dataFile = await findFile(DATA_FILE, `'${folder.id}' in parents`);
  const subsFile = await findFile(SUBS_FILE, `'${folder.id}' in parents`);
  if (!dataFile || !subsFile) {
    console.log("No se encontraron datos.json / subs.json todavía. Nada que hacer.");
    return;
  }

  async function readJson(fileId) {
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    try { return JSON.parse(res.data || "{}"); } catch (e) { return {}; }
  }
  async function writeJson(fileId, obj) {
    await drive.files.update({
      fileId,
      media: { mimeType: "application/json", body: JSON.stringify(obj) }
    });
  }

  const data = await readJson(dataFile.id);
  const deudores = Array.isArray(data.deudores) ? data.deudores : [];
  const subsData = await readJson(subsFile.id);
  const subs = Array.isArray(subsData.subs) ? subsData.subs : [];

  const today = todayInBogota();
  const hoy = [];
  const atrasados = [];
  deudores.forEach((d) => {
    if (!d.activo) return;
    const diff = diffDays(d.proximoCobro, today);
    if (diff === 0) hoy.push(d);
    else if (diff < 0) atrasados.push(d);
  });

  if (!hoy.length && !atrasados.length) {
    console.log("Nada pendiente hoy. No se envían notificaciones.");
    return;
  }

  let body;
  if (atrasados.length && hoy.length) {
    body = `${hoy.length} cobro(s) hoy y ${atrasados.length} atrasado(s).`;
  } else if (atrasados.length) {
    body = `Tienes ${atrasados.length} cobro(s) atrasado(s).`;
  } else {
    body = `Tienes ${hoy.length} cobro(s) para hoy.`;
  }
  const payload = JSON.stringify({
    title: "Libro de Fiado",
    body,
    url: "./"
  });

  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        console.log("Suscripción vencida, se elimina:", sub.endpoint);
      } else {
        console.log("Error enviando a una suscripción, se conserva:", code, err && err.message);
        stillValid.push(sub);
      }
    }
  }

  if (stillValid.length !== subs.length) {
    await writeJson(subsFile.id, { subs: stillValid });
  }

  console.log(`Listo. ${stillValid.length} dispositivo(s) notificados.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
