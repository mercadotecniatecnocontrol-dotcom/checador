'use strict';
// GET /api/resumen?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&usuario=ID
const { manejar, leerRango, resumen } = require('./_lib');

module.exports = manejar(async (req, res) => {
  const { desde, hasta } = leerRango(req.query);
  const usuario = req.query.usuario ? String(req.query.usuario) : null;
  const { filas } = await resumen({ desde, hasta, usuario, conFaltas: desde === hasta });
  const cuenta = (fn) => filas.filter(fn).length;
  const suma = (fn) => filas.reduce((n, f) => n + (fn(f) || 0), 0);
  const conteos = {
    personas: new Set(filas.map((f) => f.usuario)).size,
    presentes: cuenta((f) => f.estado === 'presente'),
    comida: cuenta((f) => f.estado === 'comida'),
    retardos: cuenta((f) => f.retardo),
    salieron: cuenta((f) => f.estado === 'salio'),
    sinRegistro: cuenta((f) => f.estado === 'sin_registro'),
    incompletos: cuenta((f) => f.estado === 'incompleto'),
    comidasExcedidas: cuenta((f) => f.comida && f.comida.exceso > 0 && !f.comida.enCurso),
    sinComida: cuenta((f) => f.sinComida),
    salidasAnticipadas: cuenta((f) => f.salidaAnticipada > 0),
    checadas: suma((f) => f.checadas.length),
    minutos: suma((f) => f.minutosTrabajados),
    debe: suma((f) => f.debe),
    aFavor: suma((f) => f.aFavor),
    saldo: suma((f) => f.saldo),
  };
  res.json({ desde, hasta, conteos, filas });
});
