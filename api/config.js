'use strict';
// Datos públicos para que la página arranque (sin información de personas).
const { CFG, diaLocal } = require('./_lib');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    hoy: diaLocal(new Date()),
    zona: CFG.tz,
    horaEntrada: CFG.horaEntrada,
    horaSalida: CFG.horaSalida,
    comidaMin: CFG.comidaMin,
    horaSabado: CFG.horaSabado,
    salidaSabado: CFG.salidaSabado,
    tolerancia: CFG.tolerancia,
  });
};
