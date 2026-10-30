'use strict';
// Funciones compartidas por la API (Vercel no publica archivos que empiezan con "_").
const { createClient } = require('@supabase/supabase-js');

const CFG = {
  tz: process.env.ZONA_HORARIA || 'America/Chihuahua',
  horaEntrada: process.env.HORA_ENTRADA || '08:30',
  tolerancia: Number(process.env.TOLERANCIA_MIN || 10),
  pin: process.env.PIN_RH || '',
};
const NOMBRE_TEMPORAL = 'Persona con ID ';

let cliente = null;
function sb() {
  if (!cliente) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de Vercel.');
    }
    cliente = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cliente;
}

function autorizado(req, res) {
  if (!CFG.pin) {
    res.status(500).json({ error: 'Falta configurar PIN_RH en las variables de Vercel.' });
    return false;
  }
  if (req.headers['x-pin'] === CFG.pin) return true;
  res.status(401).json({ error: 'PIN incorrecto.' });
  return false;
}

function manejar(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!autorizado(req, res)) return;
      await fn(req, res);
    } catch (e) {
      console.error(e);
      res.status(e.publico ? 400 : 500).json({ error: e.publico || (e.message && e.message.startsWith('Falta')) ? e.message : 'No se pudo leer la base de datos. Vuelve a intentar en un momento.' });
    }
  };
}

/* ----------------------------------------------------------------- Tiempo */
function offsetMin(fecha) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: CFG.tz, timeZoneName: 'longOffset' })
    .formatToParts(fecha).find((x) => x.type === 'timeZoneName');
  const m = p && p.value.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -v : v;
}
function inicioDelDia(dia) {
  const guess = Date.parse(`${dia}T00:00:00Z`);
  return new Date(guess - offsetMin(new Date(guess)) * 60000);
}
function sumarDias(dia, n) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaLocal = (f) => new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(f);
const horaLocal = (f) => new Intl.DateTimeFormat('es-MX', { timeZone: CFG.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(f);
const aMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const esDia = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function leerRango(q) {
  const hoy = diaLocal(new Date());
  let desde = esDia(q.desde) ? q.desde : hoy;
  let hasta = esDia(q.hasta) ? q.hasta : desde;
  if (hasta < desde) [desde, hasta] = [hasta, desde];
  const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
  if (dias > 186) throw Object.assign(new Error('Elige un rango de máximo 6 meses.'), { publico: true });
  return { desde, hasta, hoy };
}

/* -------------------------------------------------------------- Lecturas */
async function leerPersonas() {
  const { data, error } = await sb().from('checador_personas').select('*').range(0, 4999);
  if (error) throw error;
  return new Map(data.map((p) => [p.usuario_checador, p]));
}

async function leerRegistros(desde, hasta, usuario) {
  const ini = inicioDelDia(desde).toISOString();
  const fin = inicioDelDia(sumarDias(hasta, 1)).toISOString();
  const filas = [];
  for (let i = 0; ; i += 1000) {
    let q = sb().from('checador_registros')
      .select('usuario_checador, fecha_hora, metodo')
      .gte('fecha_hora', ini).lt('fecha_hora', fin);
    if (usuario) q = q.eq('usuario_checador', usuario);
    const { data, error } = await q.order('fecha_hora', { ascending: true }).order('id', { ascending: true }).range(i, i + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) break;
  }
  return filas;
}

function vistaPersona(p, usuario) {
  const nombre = p && p.nombre ? p.nombre : NOMBRE_TEMPORAL + usuario;
  return {
    usuario,
    nombre,
    departamento: p ? p.departamento : null,
    puesto: p ? p.puesto : null,
    foto: p ? p.foto_url : null,
    sinNombre: nombre.startsWith(NOMBRE_TEMPORAL),
  };
}

const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });

/*
 * Resumen por persona y día:
 * primera checada = entrada, última = salida; el tiempo se suma por pares (entrada-salida, entrada-salida...).
 */
async function resumen({ desde, hasta, usuario, conFaltas }) {
  const [personas, registros] = await Promise.all([leerPersonas(), leerRegistros(desde, hasta, usuario)]);
  const hoy = diaLocal(new Date());
  const grupos = new Map();
  for (const r of registros) {
    const f = new Date(r.fecha_hora);
    const clave = `${diaLocal(f)}|${r.usuario_checador}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(f);
  }

  const filas = [];
  for (const [clave, fechas] of grupos) {
    const [dia, u] = clave.split('|');
    const p = personas.get(u);
    const horario = p && p.hora_entrada ? String(p.hora_entrada).slice(0, 5) : CFG.horaEntrada;
    const primera = fechas[0];
    const tarde = aMin(horaLocal(primera)) - aMin(horario);
    const retardo = tarde > CFG.tolerancia;
    let ms = 0;
    for (let i = 0; i + 1 < fechas.length; i += 2) ms += fechas[i + 1] - fechas[i];
    const impar = fechas.length % 2 === 1;
    if (impar && dia === hoy) ms += Math.max(0, Date.now() - fechas[fechas.length - 1]);
    filas.push({
      dia,
      ...vistaPersona(p, u),
      horario,
      checadas: fechas.map(horaLocal),
      entrada: horaLocal(primera),
      salida: fechas.length > 1 && !impar ? horaLocal(fechas[fechas.length - 1]) : null,
      minutosTrabajados: Math.round(ms / 60000),
      retardo,
      minutosTarde: retardo ? tarde : 0,
      estado: impar ? (dia === hoy ? 'presente' : 'incompleto') : 'salio',
    });
  }

  if (conFaltas && desde === hasta) {
    const conRegistro = new Set(filas.map((f) => f.usuario));
    for (const p of personas.values()) {
      if (!p.activo || conRegistro.has(p.usuario_checador)) continue;
      if (usuario && p.usuario_checador !== usuario) continue;
      filas.push({
        dia: desde, ...vistaPersona(p, p.usuario_checador),
        horario: p.hora_entrada ? String(p.hora_entrada).slice(0, 5) : CFG.horaEntrada,
        checadas: [], entrada: null, salida: null, minutosTrabajados: 0, retardo: false, minutosTarde: 0, estado: 'sin_registro',
      });
    }
  }

  filas.sort((a, b) => (a.dia === b.dia ? porNombre(a, b) : a.dia < b.dia ? 1 : -1));
  return { filas, registros, personas };
}

const durTexto = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '');

module.exports = {
  CFG, NOMBRE_TEMPORAL, sb, manejar, leerRango, resumen, leerPersonas, vistaPersona, porNombre,
  diaLocal, horaLocal, durTexto, esDia,
};
