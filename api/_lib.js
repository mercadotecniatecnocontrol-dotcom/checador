'use strict';
// Funciones compartidas por la API (Vercel no publica archivos que empiezan con "_").
const { createClient } = require('@supabase/supabase-js');

const env = (k, d) => process.env[k] || d;
const CFG = {
  tz: env('ZONA_HORARIA', 'America/Chihuahua'),
  // Lunes a viernes
  horaEntrada: env('HORA_ENTRADA', '08:00'),
  horaSalida: env('HORA_SALIDA', '17:00'),
  comidaMin: Number(env('COMIDA_MIN', 60)),
  // Sábado (sin comida)
  horaSabado: env('HORA_ENTRADA_SABADO', '09:00'),
  salidaSabado: env('HORA_SALIDA_SABADO', '13:00'),
  // General
  tolerancia: Number(env('TOLERANCIA_MIN', 10)),
  pin: env('PIN_RH', ''),
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
const diaSemana = (dia) => new Date(`${dia}T12:00:00Z`).getUTCDay(); // 0 domingo ... 6 sábado

function leerRango(q) {
  const hoy = diaLocal(new Date());
  let desde = esDia(q.desde) ? q.desde : hoy;
  let hasta = esDia(q.hasta) ? q.hasta : desde;
  if (hasta < desde) [desde, hasta] = [hasta, desde];
  const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
  if (dias > 186) throw Object.assign(new Error('Elige un rango de máximo 6 meses.'), { publico: true });
  return { desde, hasta, hoy };
}

/* -------------------------------------------------------------- Horario */
// Reglas del día: sábado (sin comida), lunes a viernes (con comida), domingo (sin reglas).
function reglasDe(p, dia) {
  const d = diaSemana(dia);
  if (d === 0) return { tipo: 'domingo', entrada: null, salida: null, comida: false };
  if (d === 6) return { tipo: 'sabado', entrada: CFG.horaSabado, salida: CFG.salidaSabado, comida: false };
  return {
    tipo: 'semana',
    entrada: p && p.hora_entrada ? String(p.hora_entrada).slice(0, 5) : CFG.horaEntrada,
    salida: CFG.horaSalida,
    comida: true,
  };
}

// ¿La persona trabajaba en la empresa ese día? (según fecha de alta y de baja)
function vigente(p, dia) {
  if (!p) return true;
  if (p.fecha_alta && dia < String(p.fecha_alta).slice(0, 10)) return false;
  if (p.fecha_baja) return dia <= String(p.fecha_baja).slice(0, 10);
  return p.activo !== false;
}

// Minutos que debe trabajar ese día (ya sin la comida)
function minutosEsperados(p, dia) {
  const r = reglasDe(p, dia);
  if (!r.entrada) return 0;
  return aMin(r.salida) - aMin(r.entrada) - (r.comida ? CFG.comidaMin : 0);
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
 * Evalúa un día de una persona.
 * - La primera checada es la entrada y la última (si son pares) la salida, que es obligatoria.
 * - Cualquier salida a media jornada cuenta como comida, a cualquier hora.
 * - Lunes a viernes la comida es de 1 hora exacta: si toman más, deben el excedente;
 *   si toman menos o no la checan, igual se descuenta la hora completa.
 * - Sábado no hay comida: cualquier salida intermedia se debe completa.
 * - Saldo = minutos a favor (quedarse después de la salida) - minutos que debe
 *   (retardo pasado de la tolerancia + comida de más + salida antes de hora).
 */
function evaluarDia(p, dia, fechas, hoy, ahora) {
  const r = reglasDe(p, dia);
  const n = fechas.length;
  const min = fechas.map((f) => aMin(horaLocal(f)));
  const esHoy = dia === hoy;
  const minAhora = aMin(horaLocal(ahora));
  const antesDeSalida = esHoy && r.salida && minAhora < aMin(r.salida);
  const impar = n % 2 === 1;

  // Retardo (dentro de la tolerancia no cuenta)
  let retardo = false; let minutosTarde = 0;
  if (r.entrada) {
    const tarde = min[0] - aMin(r.entrada);
    if (tarde > CFG.tolerancia) { retardo = true; minutosTarde = tarde; }
  }

  // Estado
  let estado;
  if (impar) estado = esHoy ? 'presente' : 'incompleto';
  else if (r.comida && n === 2 && antesDeSalida) estado = 'comida';
  else estado = 'salio';

  // Tiempo fuera a media jornada (todas las salidas intermedias)
  let fueraMin = 0; let salidas = 0;
  for (let i = 1; i + 1 < n; i += 2) { fueraMin += min[i + 1] - min[i]; salidas += 1; }
  if (estado === 'comida') { fueraMin += minAhora - min[1]; salidas += 1; }

  let comida = null;
  if (r.comida && salidas) {
    comida = {
      salida: horaLocal(fechas[1]),
      regreso: n >= 3 ? horaLocal(fechas[2]) : null,
      minutos: fueraMin,
      salidas,
      enCurso: estado === 'comida',
      exceso: Math.max(0, fueraMin - CFG.comidaMin),
    };
  }
  const sinComida = r.comida && n === 2 && estado === 'salio';
  const descuento = r.comida ? Math.max(CFG.comidaMin, fueraMin) : fueraMin;
  const fueraDeMas = r.comida ? Math.max(0, fueraMin - CFG.comidaMin) : fueraMin;

  // Salida antes de hora o tiempo extra
  let salidaAnticipada = 0; let extra = 0;
  if (estado === 'salio' && r.salida) {
    const d = aMin(r.salida) - min[n - 1];
    if (d > 0) salidaAnticipada = d; else if (d < 0) extra = -d;
  }

  // Tiempo trabajado (ya sin la comida)
  let trabajado;
  if (estado === 'salio') trabajado = (min[n - 1] - min[0]) - (n === 2 && !r.comida ? 0 : descuento);
  else if (estado === 'comida') trabajado = min[1] - min[0];
  else if (estado === 'presente') trabajado = (minAhora - min[0]) - fueraMin;
  else trabajado = (min[n - 1] - min[0]) - fueraMin; // incompleto: hasta la última checada
  if (n === 1 && estado === 'incompleto') trabajado = 0;
  trabajado = Math.max(0, trabajado);

  // Saldo: solo con el día cerrado (con salida)
  let debe = null; let aFavor = null; let saldo = null;
  if (estado === 'salio') {
    if (r.tipo === 'domingo') { debe = 0; aFavor = trabajado; }
    else { debe = minutosTarde + fueraDeMas + salidaAnticipada; aFavor = extra; }
    saldo = aFavor - debe;
  }

  return {
    horario: r.entrada ? `${r.entrada} a ${r.salida}` : 'Domingo',
    horaEntrada: r.entrada,
    tipoDia: r.tipo,
    checadas: fechas.map(horaLocal),
    entrada: horaLocal(fechas[0]),
    salida: estado === 'salio' && n > 1 ? horaLocal(fechas[n - 1]) : null,
    comida, sinComida,
    minutosFuera: fueraMin,
    minutosFueraDeMas: fueraDeMas,
    minutosTrabajados: trabajado,
    retardo, minutosTarde, salidaAnticipada, minutosExtra: extra,
    debe, aFavor, saldo,
    estado,
  };
}

async function resumen({ desde, hasta, usuario, conFaltas }) {
  const [personas, registros] = await Promise.all([leerPersonas(), leerRegistros(desde, hasta, usuario)]);
  const ahora = new Date();
  const hoy = diaLocal(ahora);
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
    filas.push({ dia, ...vistaPersona(p, u), ...evaluarDia(p, dia, fechas, hoy, ahora) });
  }

  if (conFaltas && desde === hasta && diaSemana(desde) !== 0) {
    const conRegistro = new Set(filas.map((f) => f.usuario));
    for (const p of personas.values()) {
      if (!vigente(p, desde) || conRegistro.has(p.usuario_checador)) continue;
      if (usuario && p.usuario_checador !== usuario) continue;
      const r = reglasDe(p, desde);
      filas.push({
        dia: desde, ...vistaPersona(p, p.usuario_checador),
        horario: `${r.entrada} a ${r.salida}`, horaEntrada: r.entrada, tipoDia: r.tipo,
        checadas: [], entrada: null, salida: null, comida: null, sinComida: false, minutosFuera: 0, minutosFueraDeMas: 0,
        minutosTrabajados: 0, retardo: false, minutosTarde: 0, salidaAnticipada: 0, minutosExtra: 0,
        debe: null, aFavor: null, saldo: null, estado: 'sin_registro',
      });
    }
  }

  filas.sort((a, b) => (a.dia === b.dia ? porNombre(a, b) : a.dia < b.dia ? 1 : -1));
  return { filas, registros, personas };
}

// Qué es cada checada según su lugar en el día
function etiquetaChecada(indice, total, dia) {
  if (indice === 0) return 'Entrada';
  if (indice === total - 1 && total % 2 === 0) return 'Salida';
  const semana = diaSemana(dia) >= 1 && diaSemana(dia) <= 5;
  if (semana && indice <= 2) return indice === 1 ? 'Salida a comer' : 'Regreso de comida';
  return indice % 2 === 1 ? 'Sale a media jornada' : 'Regresa';
}

// Minutos -> "1:05" (con signo si se pide)
const durTexto = (m, conSigno) => {
  if (m == null) return '';
  const a = Math.abs(m);
  const t = `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  return conSigno ? `${m < 0 ? '-' : m > 0 ? '+' : ''}${t}` : (m ? t : '');
};

module.exports = {
  CFG, NOMBRE_TEMPORAL, sb, manejar, leerRango, resumen, leerPersonas, vistaPersona, porNombre,
  diaLocal, horaLocal, durTexto, esDia, etiquetaChecada, vigente, minutosEsperados, diaSemana, sumarDias, reglasDe,
};
