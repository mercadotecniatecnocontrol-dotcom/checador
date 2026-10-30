'use strict';
/*
 * Recibe las checadas que el Hikvision envía solo (HTTP Listening por HTTPS).
 * En el checador:  dominio = tu-proyecto.vercel.app, URL = /hk/<HIKVISION_TOKEN>, puerto 443, HTTPS.
 * La ruta /hk/<clave> se redirige aquí desde vercel.json.
 */
const { sb, NOMBRE_TEMPORAL } = require('./_lib');

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (d) => partes.push(d));
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

// El checador manda multipart/form-data con un campo "event_log" (JSON) y a veces la foto.
function extraerEventos(buf, tipo) {
  const textos = [];
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(tipo || '');
  if (m) {
    const limite = `--${(m[1] || m[2]).trim()}`;
    for (const parte of buf.toString('latin1').split(limite)) {
      const i = parte.indexOf('\r\n\r\n');
      if (i < 0) continue;
      if (/content-type:\s*image\//i.test(parte.slice(0, i))) continue; // se ignoran las fotos
      textos.push(Buffer.from(parte.slice(i + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8'));
    }
  } else {
    textos.push(buf.toString('utf8'));
  }
  const eventos = [];
  for (const t of textos) {
    let j = t.trim();
    if (j.startsWith('event_log=')) j = decodeURIComponent(j.slice(10).replace(/\+/g, ' '));
    if (!j.startsWith('{')) continue;
    try { eventos.push(JSON.parse(j)); } catch (e) { /* parte que no es JSON */ }
  }
  return eventos;
}

async function guardarPersonas(registros) {
  const nombres = new Map();
  for (const r of registros) if (!nombres.has(r.usuario_checador) || r._nombre) nombres.set(r.usuario_checador, r._nombre);
  const ids = [...nombres.keys()];
  const { data: existentes, error } = await sb().from('checador_personas').select('usuario_checador, nombre').in('usuario_checador', ids);
  if (error) throw error;
  const yaEstan = new Map(existentes.map((p) => [p.usuario_checador, p.nombre]));

  const nuevas = ids.filter((id) => !yaEstan.has(id)).map((id) => ({ usuario_checador: id, nombre: nombres.get(id) || NOMBRE_TEMPORAL + id }));
  if (nuevas.length) {
    const { error: e2 } = await sb().from('checador_personas').upsert(nuevas, { onConflict: 'usuario_checador', ignoreDuplicates: true });
    if (e2) throw e2;
  }
  // Si RH no le ha puesto nombre y el checador sí lo trae, se completa solo
  for (const id of ids) {
    const actual = yaEstan.get(id);
    const delChecador = nombres.get(id);
    if (actual !== undefined && delChecador && (!actual || actual.startsWith(NOMBRE_TEMPORAL))) {
      await sb().from('checador_personas').update({ nombre: delChecador, actualizado_en: new Date().toISOString() }).eq('usuario_checador', id);
    }
  }
}

module.exports = async (req, res) => {
  const token = process.env.HIKVISION_TOKEN || '';
  if (!token || req.query.token !== token) return res.status(404).send('No encontrado');
  if (req.method !== 'POST') return res.status(200).send('Checador Tecnocontrol: listo para recibir checadas.');

  try {
    const buf = await leerCuerpo(req);
    const eventos = extraerEventos(buf, req.headers['content-type']);
    const minores = String(process.env.CHECADOR_MINORES || '').split(',').map(Number).filter((n) => n > 0);

    let serie = null;
    let ip = null;
    const registros = [];
    for (const e of eventos) {
      const a = e.AccessControllerEvent || {};
      serie = serie || e.macAddress || a.deviceName || e.ipAddress || null;
      ip = ip || e.ipAddress || null;
      const usuario = String(a.employeeNoString || a.employeeNo || '').trim();
      if (e.eventType !== 'AccessControllerEvent' || !usuario) continue;
      if (Number(a.majorEventType) !== 5) continue;
      if (minores.length && !minores.includes(Number(a.subEventType))) continue;
      const fecha = new Date(e.dateTime);
      if (isNaN(fecha)) continue;
      registros.push({
        usuario_checador: usuario,
        fecha_hora: fecha.toISOString(),
        metodo: a.currentVerifyMode || null,
        estado_checador: a.attendanceStatus || null,
        dispositivo_serie: serie,
        origen: 'hikvision',
        datos: { serialNo: a.serialNo ?? null, minor: a.subEventType ?? null },
        _nombre: String(a.name || '').trim(),
      });
    }

    if (registros.length) {
      await guardarPersonas(registros);
      const lote = registros.map(({ _nombre, ...r }) => r);
      const { error } = await sb().from('checador_registros').upsert(lote, { onConflict: 'usuario_checador,fecha_hora', ignoreDuplicates: true });
      if (error) throw error;
    }

    const estado = { serie: serie || 'Checador', ip, ultimo_contacto: new Date().toISOString(), ultimo_error: null };
    if (registros.length) estado.ultima_checada = registros.map((r) => r.fecha_hora).sort().pop();
    if (!eventos.length && buf.length) estado.ultimo_error = `Llegó un aviso que no se pudo leer: ${buf.toString('utf8', 0, 160)}`;
    await sb().from('checador_dispositivos').upsert(estado, { onConflict: 'serie' });

    res.status(200).json({ ok: true, guardadas: registros.length });
  } catch (e) {
    console.error('Error guardando checada del Hikvision:', e);
    res.status(500).json({ ok: false }); // el checador lo vuelve a intentar
  }
};
