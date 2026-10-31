'use strict';
// GET /api/descargar?desde&hasta&usuario&tipo=resumen|detalle  -> archivo CSV que abre en Excel
const { manejar, leerRango, resumen, vistaPersona, diaLocal, horaLocal, durTexto, etiquetaChecada, porNombre } = require('./_lib');

const celda = (v) => {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita que Excel lo tome como fórmula
  return `"${s.replace(/"/g, '""')}"`;
};
const fechaMx = (dia) => dia.split('-').reverse().join('/');
const ESTADOS = { presente: 'Trabajando', comida: 'En comida', salio: 'Completo', incompleto: 'FALTA CHECADA DE SALIDA', sin_registro: 'Sin registro' };
const METODOS = { face: 'Rostro', fingerPrint: 'Huella', card: 'Tarjeta', password: 'Contraseña' };
const saldoTexto = (m) => (m == null ? '' : m < 0 ? `Debe ${durTexto(m)}` : m > 0 ? `A favor ${durTexto(m)}` : 'Al corriente');

function observaciones(f) {
  const o = [];
  if (f.estado === 'incompleto') o.push('Falta checada de salida (obligatoria)');
  if (f.retardo) o.push(`Retardo de ${f.minutosTarde} min`);
  if (f.comida && f.comida.exceso && !f.comida.enCurso) o.push(`Comida ${f.comida.exceso} min de más`);
  if (f.comida && f.comida.salidas > 1) o.push(`Salió ${f.comida.salidas} veces a media jornada`);
  if (f.tipoDia === 'sabado' && f.minutosFuera) o.push(`Salió ${f.minutosFuera} min a media jornada`);
  if (f.sinComida) o.push('No checó comida (se descuenta 1 h)');
  if (f.salidaAnticipada) o.push(`Salió ${f.salidaAnticipada} min antes`);
  if (f.minutosExtra) o.push(`Se quedó ${f.minutosExtra} min de más`);
  return o.join('; ');
}

module.exports = manejar(async (req, res) => {
  const { desde, hasta } = leerRango(req.query);
  const usuario = req.query.usuario ? String(req.query.usuario) : null;
  const tipo = req.query.tipo === 'detalle' ? 'detalle' : 'resumen';
  const { filas, registros, personas } = await resumen({ desde, hasta, usuario, conFaltas: desde === hasta });

  let tabla;
  if (tipo === 'resumen') {
    tabla = [['Fecha', 'Nombre', 'No. de empleado', 'Departamento', 'Horario', 'Entrada', 'Salida a comer', 'Regreso de comida',
      'Minutos fuera (comida)', 'Salida', 'Horas trabajadas', 'Minutos de retardo', 'Minutos de comida de más',
      'Minutos de salida anticipada', 'Minutos que debe', 'Minutos a favor', 'Saldo del día', 'Todas las checadas', 'Estado', 'Observaciones']];
    for (const f of [...filas].reverse()) {
      const c = f.comida || {};
      tabla.push([fechaMx(f.dia), f.nombre, f.usuario, f.departamento, f.horario, f.entrada,
        c.salida || '', c.regreso || '', f.minutosFuera || '', f.salida, durTexto(f.minutosTrabajados),
        f.minutosTarde || '', f.minutosFueraDeMas || '', f.salidaAnticipada || '',
        f.debe == null ? '' : f.debe, f.aFavor == null ? '' : f.aFavor, saldoTexto(f.saldo),
        f.checadas.join('  '), ESTADOS[f.estado], observaciones(f)]);
    }

    // Totales por persona (para nómina)
    const porPersona = new Map();
    for (const f of filas) {
      if (f.estado === 'sin_registro') continue;
      const t = porPersona.get(f.usuario) || { nombre: f.nombre, usuario: f.usuario, departamento: f.departamento, dias: 0, minutos: 0, retardos: 0, debe: 0, aFavor: 0, sinSalida: 0 };
      t.dias += 1; t.minutos += f.minutosTrabajados; t.retardos += f.retardo ? 1 : 0;
      t.debe += f.debe || 0; t.aFavor += f.aFavor || 0; t.sinSalida += f.estado === 'incompleto' ? 1 : 0;
      porPersona.set(f.usuario, t);
    }
    if (porPersona.size) {
      tabla.push([], ['TOTALES POR PERSONA'], ['Nombre', 'No. de empleado', 'Departamento', 'Días con checadas', 'Horas trabajadas',
        'Retardos', 'Días sin checada de salida', 'Minutos que debe', 'Minutos a favor', 'Saldo del periodo']);
      for (const t of [...porPersona.values()].sort(porNombre)) {
        tabla.push([t.nombre, t.usuario, t.departamento, t.dias, durTexto(t.minutos), t.retardos, t.sinSalida,
          t.debe, t.aFavor, saldoTexto(t.aFavor - t.debe) + (t.sinSalida ? ` (sin contar ${t.sinSalida} día${t.sinSalida > 1 ? 's' : ''} sin salida)` : '')]);
      }
    }
  } else {
    const totales = new Map();
    for (const r of registros) {
      const clave = `${diaLocal(new Date(r.fecha_hora))}|${r.usuario_checador}`;
      totales.set(clave, (totales.get(clave) || 0) + 1);
    }
    tabla = [['Fecha', 'Hora', 'Nombre', 'No. de empleado', 'Departamento', 'Tipo', 'Método']];
    const cuenta = new Map();
    for (const r of registros) {
      const f = new Date(r.fecha_hora);
      const dia = diaLocal(f);
      const clave = `${dia}|${r.usuario_checador}`;
      const i = cuenta.get(clave) || 0;
      cuenta.set(clave, i + 1);
      const p = vistaPersona(personas.get(r.usuario_checador), r.usuario_checador);
      tabla.push([fechaMx(dia), horaLocal(f), p.nombre, p.usuario, p.departamento,
        etiquetaChecada(i, totales.get(clave), dia), METODOS[r.metodo] || r.metodo || '']);
    }
  }

  const nombre = `checadas-${tipo}-${desde}${hasta !== desde ? `-al-${hasta}` : ''}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send('\uFEFF' + tabla.map((f) => f.map(celda).join(',')).join('\r\n'));
});
