'use strict';
// GET /api/personas      -> lista en orden alfabético
// POST /api/personas     -> guardar (alta o cambio) por ID del checador
const { manejar, sb, porNombre, diaLocal, esDia } = require('./_lib');

module.exports = manejar(async (req, res) => {
  if (req.method === 'POST') {
    const b = req.body || {};
    const usuario = String(b.usuario_checador || '').trim();
    const nombre = String(b.nombre || '').trim();
    if (!usuario || !nombre) return res.status(400).json({ error: 'Escribe el número de empleado y el nombre completo.' });
    const alta = esDia(b.fecha_alta) ? b.fecha_alta : null;
    const baja = esDia(b.fecha_baja) ? b.fecha_baja : null;
    if (alta && baja && baja < alta) return res.status(400).json({ error: 'La fecha de baja no puede ser antes de la fecha de alta.' });
    const limpio = (v) => String(v || '').trim() || null;
    const { data, error } = await sb().from('checador_personas').upsert({
      usuario_checador: usuario,
      nombre,
      departamento: limpio(b.departamento),
      puesto: limpio(b.puesto),
      foto_url: limpio(b.foto_url),
      hora_entrada: /^\d{2}:\d{2}$/.test(b.hora_entrada || '') ? b.hora_entrada : null,
      fecha_alta: alta,
      fecha_baja: baja,
      activo: !baja || baja >= diaLocal(new Date()),
      actualizado_en: new Date().toISOString(),
    }, { onConflict: 'usuario_checador' }).select();
    if (error) throw error;
    return res.json(data[0]);
  }
  const { data, error } = await sb().from('checador_personas').select('*').range(0, 4999);
  if (error) throw error;
  res.json(data.sort(porNombre));
});
