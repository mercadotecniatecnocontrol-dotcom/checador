'use strict';
// Datos públicos para que la página arranque (sin información de personas).
const { CFG, diaLocal } = require('./_lib');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    hoy: diaLocal(new Date()),
    zona: CFG.tz,
    horaEntrada: CFG.horaEntrada,
    horaSabado: CFG.horaSabado,
    tolerancia: CFG.tolerancia,
  });
};
