'use strict';
// GET /api/estado -> cuándo fue la última vez que el puente leyó cada checador
const { manejar, sb } = require('./_lib');

module.exports = manejar(async (req, res) => {
  const { data, error } = await sb().from('checador_dispositivos').select('*').order('serie');
  if (error) throw error;
  res.json({ ahora: new Date().toISOString(), checadores: data });
});
