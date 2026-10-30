'use strict';
// GET /api/descargar?desde&hasta&usuario&tipo=resumen|detalle  -> archivo CSV que abre en Excel
const { manejar, leerRango, resumen, vistaPersona, diaLocal, horaLocal, durTexto } = require('./_lib');

const celda = (v) => {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita fórmulas al abrir en Excel
  return `"${s.replace(/"/g, '""')}"`;
};
const fechaMx = (dia) => dia.split('-').reverse().join('/');
const ESTADOS = { presente: 'Trabajando', salio: 'Completo', incompleto: 'Falta checada de salida', sin_registro: 'Sin registro' };
const METODOS = { face: 'Rostro', fingerPrint: 'Huella', card: 'Tarjeta', password: 'Contraseña' };

module.exports = manejar(async (req, res) => {
  const { desde, hasta } = leerRango(req.query);
  const usuario = req.query.usuario ? String(req.query.usuario) : null;
  const tipo = req.query.tipo === 'detalle' ? 'detalle' : 'resumen';
  const { filas, registros, personas } = await resumen({ desde, hasta, usuario, conFaltas: desde === hasta });

  let tabla;
  if (tipo === 'resumen') {
    tabla = [['Fecha', 'Nombre', 'No. de empleado', 'Departamento', 'Hora de entrada asignada', 'Entrada', 'Salida',
      'Todas las checadas', 'Horas trabajadas', 'Minutos de retardo', 'Estado']];
    for (const f of [...filas].reverse()) {
      tabla.push([fechaMx(f.dia), f.nombre, f.usuario, f.departamento, f.horario, f.entrada, f.salida,
        f.checadas.join('  '), durTexto(f.minutosTrabajados), f.minutosTarde || '', ESTADOS[f.estado]]);
    }
  } else {
    tabla = [['Fecha', 'Hora', 'Nombre', 'No. de empleado', 'Departamento', 'Tipo', 'Método']];
    const cuenta = new Map();
    for (const r of registros) {
      const f = new Date(r.fecha_hora);
      const dia = diaLocal(f);
      const clave = `${dia}|${r.usuario_checador}`;
      const n = (cuenta.get(clave) || 0) + 1;
      cuenta.set(clave, n);
      const p = vistaPersona(personas.get(r.usuario_checador), r.usuario_checador);
      tabla.push([fechaMx(dia), horaLocal(f), p.nombre, p.usuario, p.departamento,
        n % 2 === 1 ? 'Entrada' : 'Salida', METODOS[r.metodo] || r.metodo || '']);
    }
  }

  const nombre = `checadas-${tipo}-${desde}${hasta !== desde ? `-al-${hasta}` : ''}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send('\uFEFF' + tabla.map((f) => f.map(celda).join(',')).join('\r\n'));
});
