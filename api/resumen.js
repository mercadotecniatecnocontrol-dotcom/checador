'use strict';
// GET /api/resumen?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&usuario=ID
const { manejar, leerRango, resumen } = require('./_lib');

module.exports = manejar(async (req, res) => {
  const { desde, hasta } = leerRango(req.query);
  const usuario = req.query.usuario ? String(req.query.usuario) : null;
  const { filas } = await resumen({ desde, hasta, usuario, conFaltas: desde === hasta });
  const conteos = {
    personas: new Set(filas.map((f) => f.usuario)).size,
    presentes: filas.filter((f) => f.estado === 'presente').length,
    retardos: filas.filter((f) => f.retardo).length,
    salieron: filas.filter((f) => f.estado === 'salio').length,
    sinRegistro: filas.filter((f) => f.estado === 'sin_registro').length,
    incompletos: filas.filter((f) => f.estado === 'incompleto').length,
    checadas: filas.reduce((n, f) => n + f.checadas.length, 0),
    minutos: filas.reduce((n, f) => n + f.minutosTrabajados, 0),
  };
  res.json({ desde, hasta, conteos, filas });
});
