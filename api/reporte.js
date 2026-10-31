'use strict';
/*
 * GET /api/reporte?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&usuario=ID
 * Excel (.xlsx) con las mismas 4 hojas del reporte del checador Hikvision:
 *   Reporte de Turnos, Reporte Estadístico, Reporte de Asistencia y Reporte de Excepciones,
 * calculado con las reglas de Tecnocontrol.
 */
const ExcelJS = require('exceljs');
const {
  CFG, manejar, leerRango, resumen, vistaPersona, porNombre, vigente, minutosEsperados,
  diaSemana, sumarDias,
} = require('./_lib');

const NAVY = 'FF1D2E73';
const ROJO = 'FFE7402B';
const GRIS = 'FFD8DDEA';
const PAPEL = 'FFF2F4F9';
const VERDE_SUAVE = 'FFE2F4EC';
const ROJO_SUAVE = 'FFFDE8E4';
const AMBAR_SUAVE = 'FFFFF3D6';
const LETRA = 'Arial';
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const borde = { style: 'thin', color: { argb: GRIS } };
const bordes = { top: borde, left: borde, bottom: borde, right: borde };
const relleno = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const hhmm = (m) => `${Math.floor(Math.abs(m) / 60)}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
const fechaMx = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

function estilizarEncabezado(fila) {
  fila.eachCell({ includeEmpty: true }, (c) => {
    c.font = { name: LETRA, bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    c.fill = relleno(NAVY);
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { top: { style: 'thin', color: { argb: 'FF3B4FA8' } }, left: { style: 'thin', color: { argb: 'FF3B4FA8' } }, bottom: { style: 'thin', color: { argb: 'FF3B4FA8' } }, right: { style: 'thin', color: { argb: 'FF3B4FA8' } } };
  });
}

// Título, periodo y franja de marca en las primeras filas de cada hoja
function cabecera(ws, titulo, periodo, columnas, logoId, extra) {
  ws.getRow(1).height = 34;
  ws.mergeCells(1, 1, 1, columnas);
  const t = ws.getCell(1, 1);
  t.value = titulo;
  t.font = { name: LETRA, bold: true, size: 16, color: { argb: NAVY } };
  t.alignment = { vertical: 'middle', horizontal: 'center' };
  if (logoId !== null) ws.addImage(logoId, { tl: { col: 0.1, row: 0.1 }, ext: { width: 120, height: 36 } });

  ws.getRow(2).height = 4;
  for (let c = 1; c <= columnas; c++) ws.getCell(2, c).fill = relleno(c <= Math.ceil(columnas * 0.72) ? NAVY : ROJO);

  ws.getCell(3, 1).value = 'Periodo:';
  ws.getCell(3, 1).font = { name: LETRA, bold: true, size: 9 };
  ws.getCell(3, 3).value = periodo;
  ws.getCell(3, 3).font = { name: LETRA, size: 9 };
  if (extra) {
    ws.getCell(3, extra.col).value = extra.texto;
    ws.getCell(3, extra.col).font = { name: LETRA, size: 8, italic: true, color: { argb: 'FF5A6482' } };
  }
}

async function cargarLogo(req, wb) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const r = await fetch(`https://${host}/logo.png`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return wb.addImage({ buffer: Buffer.from(await r.arrayBuffer()), extension: 'png' });
  } catch (e) { return null; }
}

module.exports = manejar(async (req, res) => {
  const { desde, hasta, hoy } = leerRango(req.query);
  const usuario = req.query.usuario ? String(req.query.usuario) : null;
  const { filas, personas } = await resumen({ desde, hasta, usuario, conFaltas: false });

  const dias = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) dias.push(d);
  const porClave = new Map(filas.map((f) => [`${f.dia}|${f.usuario}`, f]));

  // Personas del reporte: las que trabajaban en algún día del periodo o que checaron
  const ids = new Set(filas.map((f) => f.usuario));
  for (const p of personas.values()) if (dias.some((d) => vigente(p, d))) ids.add(p.usuario_checador);
  const gente = [...ids]
    .filter((u) => !usuario || u === usuario)
    .map((u) => ({ p: personas.get(u), ...vistaPersona(personas.get(u), u) }))
    .sort(porNombre);

  // Día laborable a evaluar: lunes a sábado, dentro de alta/baja y ya transcurrido
  const laborable = (p, d) => diaSemana(d) !== 0 && vigente(p, d) && d <= hoy;
  const esFalta = (p, d, f) => laborable(p, d) && !f && d < hoy;

  const periodo = `${desde} ~ ${hasta}`;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HEDMA TECNOCONTROL · Recursos Humanos';
  wb.created = new Date();
  const logoId = await cargarLogo(req, wb);

  /* ===================== 1. Reporte de Turnos ===================== */
  {
    const ws = wb.addWorksheet('Reporte de Turnos', { views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }] });
    const cols = 3 + dias.length;
    cabecera(ws, 'Reporte de Turnos', periodo, cols, logoId, { col: Math.min(cols, 12), texto: `1 = turno normal (L-V ${CFG.horaEntrada}–${CFG.horaSalida}, sábado ${CFG.horaSabado}–${CFG.salidaSabado}).  Verde: asistió.  Rojo: falta.  Vacío: domingo o fuera de alta/baja.` });
    const h1 = ws.getRow(4); const h2 = ws.getRow(5);
    h1.values = ['ID', 'Nombre', 'Departamento', ...dias.map((d) => Number(d.slice(8)))];
    h2.values = ['', '', '', ...dias.map((d) => DIAS_CORTOS[diaSemana(d)])];
    for (const c of [1, 2, 3]) ws.mergeCells(4, c, 5, c);
    estilizarEncabezado(h1); estilizarEncabezado(h2);
    ws.getColumn(1).width = 8; ws.getColumn(2).width = 30; ws.getColumn(3).width = 16;
    dias.forEach((d, i) => { ws.getColumn(4 + i).width = 4.5; });

    for (const g of gente) {
      const fila = ws.addRow([g.usuario, g.nombre, g.departamento || '', ...dias.map((d) => (diaSemana(d) !== 0 && vigente(g.p, d) ? 1 : null))]);
      fila.eachCell({ includeEmpty: true }, (c, n) => {
        c.font = { name: LETRA, size: 9 }; c.border = bordes;
        if (n > 3) {
          c.alignment = { horizontal: 'center' };
          const d = dias[n - 4];
          const f = porClave.get(`${d}|${g.usuario}`);
          if (f) c.fill = relleno(VERDE_SUAVE);
          else if (esFalta(g.p, d, f)) c.fill = relleno(ROJO_SUAVE);
          else if (diaSemana(d) === 0) c.fill = relleno(PAPEL);
        }
      });
    }
  }

  /* ===================== 2. Reporte Estadístico ===================== */
  const stats = gente.map((g) => {
    const t = {
      normal: 0, real: 0, retCant: 0, retMin: 0, tempCant: 0, tempMin: 0, comCant: 0, comMin: 0,
      extraLab: 0, extraFest: 0, diasNormal: 0, diasReal: 0, sinSalida: 0, faltas: 0, debe: 0, aFavor: 0,
    };
    for (const d of dias) {
      const f = porClave.get(`${d}|${g.usuario}`);
      if (laborable(g.p, d)) { t.diasNormal += 1; t.normal += minutosEsperados(g.p, d); }
      if (esFalta(g.p, d, f)) t.faltas += 1;
      if (!f) continue;
      t.diasReal += 1;
      t.real += f.minutosTrabajados;
      if (f.retardo) { t.retCant += 1; t.retMin += f.minutosTarde; }
      if (f.salidaAnticipada) { t.tempCant += 1; t.tempMin += f.salidaAnticipada; }
      if (f.minutosFueraDeMas) { t.comCant += 1; t.comMin += f.minutosFueraDeMas; }
      if (diaSemana(d) === 0) t.extraFest += f.minutosTrabajados;
      else t.extraLab += f.minutosExtra || 0;
      if (f.estado === 'incompleto') t.sinSalida += 1;
      t.debe += f.debe || 0; t.aFavor += f.aFavor || 0;
    }
    return { g, t };
  });
  {
    const ws = wb.addWorksheet('Reporte Estadístico', { views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }] });
    const enc1 = ['ID', 'Nombre', 'Departamento', 'Horas Laborales', '', 'Retardos', '', 'Salidas Temprano', '', 'Comida de más', '', 'Tiempo Extra', '',
      'Días Asistidos (Normal/Real)', 'Falta (Días)', 'Sin checada de salida (Días)', 'Saldo de tiempo', '', '', 'Fecha de alta', 'Fecha de baja', 'Notas'];
    const enc2 = ['', '', '', 'Normal', 'Real', 'Cantidad', 'Minuto', 'Cantidad', 'Minuto', 'Cantidad', 'Minuto', 'En Días Laborales', 'En Días Festivos',
      '', '', '', 'Debe', 'A favor', 'Saldo', '', '', ''];
    cabecera(ws, 'Reporte Estadístico de Asistencia', periodo, enc1.length, logoId);
    ws.getRow(4).values = enc1; ws.getRow(5).values = enc2;
    for (const c of [1, 2, 3, 14, 15, 16, 20, 21, 22]) ws.mergeCells(4, c, 5, c);
    for (const [a, b] of [[4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [17, 19]]) ws.mergeCells(4, a, 4, b);
    estilizarEncabezado(ws.getRow(4)); estilizarEncabezado(ws.getRow(5));
    ws.getRow(4).height = 30;
    const anchos = [8, 30, 16, 9, 9, 9, 9, 9, 9, 9, 9, 11, 11, 13, 9, 12, 9, 9, 10, 12, 12, 40];
    anchos.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    for (const { g, t } of stats) {
      const saldo = t.aFavor - t.debe;
      const notas = [];
      if (t.faltas) notas.push(`${t.faltas} falta${t.faltas > 1 ? 's' : ''}`);
      if (t.sinSalida) notas.push(`${t.sinSalida} día${t.sinSalida > 1 ? 's' : ''} sin checada de salida (no se calcula su saldo)`);
      if (g.sinNombre) notas.push('Falta su nombre en la página');
      const fila = ws.addRow([g.usuario, g.nombre, g.departamento || '', hhmm(t.normal), hhmm(t.real), t.retCant, t.retMin, t.tempCant, t.tempMin,
        t.comCant, t.comMin, hhmm(t.extraLab), hhmm(t.extraFest), `${t.diasNormal}/${t.diasReal}`, t.faltas, t.sinSalida,
        hhmm(t.debe), hhmm(t.aFavor), saldo < 0 ? `-${hhmm(saldo)}` : saldo > 0 ? `+${hhmm(saldo)}` : '0:00',
        fechaMx(g.p && g.p.fecha_alta), fechaMx(g.p && g.p.fecha_baja), notas.join('; ')]);
      fila.eachCell({ includeEmpty: true }, (c, n) => {
        c.font = { name: LETRA, size: 9 }; c.border = bordes;
        c.alignment = { horizontal: n <= 3 || n === 22 ? 'left' : 'center', vertical: 'middle', wrapText: n === 22 };
      });
      if (t.retCant) fila.getCell(6).font = fila.getCell(7).font = { name: LETRA, size: 9, color: { argb: 'FFB42A18' }, bold: true };
      if (t.faltas) fila.getCell(15).fill = relleno(ROJO_SUAVE);
      if (t.sinSalida) fila.getCell(16).fill = relleno(AMBAR_SUAVE);
      fila.getCell(19).font = { name: LETRA, size: 9, bold: true, color: { argb: saldo < 0 ? 'FFB42A18' : saldo > 0 ? 'FF12805A' : NAVY } };
    }
    const nota = ws.addRow([]);
    ws.addRow([`Horas Laborales Normal: lunes a viernes ${CFG.horaEntrada}–${CFG.horaSalida} menos ${CFG.comidaMin} min de comida; sábado ${CFG.horaSabado}–${CFG.salidaSabado}. Tolerancia de entrada: ${CFG.tolerancia} min. Saldo = tiempo a favor (quedarse después de la salida) menos lo que debe (retardo, comida de más y salida temprano). Las faltas se cuentan aparte.`]);
    ws.mergeCells(nota.number + 1, 1, nota.number + 1, 22);
    const cNota = ws.getCell(nota.number + 1, 1);
    cNota.font = { name: LETRA, size: 8, italic: true, color: { argb: 'FF5A6482' } };
    cNota.alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(nota.number + 1).height = 30;
  }

  /* ===================== 3. Reporte de Asistencia ===================== */
  {
    const ws = wb.addWorksheet('Reporte de Asistencia', { views: [{ state: 'frozen', ySplit: 4 }] });
    const cols = Math.max(dias.length, 16);
    cabecera(ws, 'Reporte de Eventos de Asistencia', periodo, cols, logoId, { col: Math.max(cols - 4, 8), texto: `Fecha actual: ${hoy}` });
    const enc = ws.getRow(4);
    enc.values = dias.map((d) => `${Number(d.slice(8))}\n${DIAS_CORTOS[diaSemana(d)]}`);
    estilizarEncabezado(enc); enc.height = 26;
    for (let c = 1; c <= cols; c++) ws.getColumn(c).width = 7.5;

    for (const g of gente) {
      const info = ws.addRow([]);
      const datos = [['ID:', g.usuario], ['Nombre:', g.nombre], ['Departamento:', g.departamento || ''], ['Alta:', fechaMx(g.p && g.p.fecha_alta) || '—'], ['Baja:', fechaMx(g.p && g.p.fecha_baja) || '—']];
      // etiqueta, valor y hasta qué columna se extiende el valor
      const posiciones = [[1, 2, 2], [3, 4, 8], [9, 10, 11], [12, 13, 13], [14, 15, 16]];
      datos.forEach(([etq, val], i) => {
        const [col, colVal, colFin] = posiciones[i];
        info.getCell(col).value = etq;
        info.getCell(colVal).value = val;
        if (colFin > colVal) ws.mergeCells(info.number, colVal, info.number, colFin);
        info.getCell(col).font = { name: LETRA, size: 9, bold: true, color: { argb: NAVY } };
        info.getCell(colVal).font = { name: LETRA, size: 9, bold: i === 1 };
      });
      for (let c = 1; c <= cols; c++) { info.getCell(c).fill = relleno(PAPEL); info.getCell(c).border = { top: borde }; }

      let maximo = 1;
      const fila = ws.addRow(dias.map((d) => {
        const f = porClave.get(`${d}|${g.usuario}`);
        if (f) { maximo = Math.max(maximo, f.checadas.length); return f.checadas.join('\n'); }
        if (esFalta(g.p, d, f)) return 'Falta';
        return '';
      }));
      fila.height = Math.max(15, 12 * maximo + 4);
      fila.eachCell({ includeEmpty: true }, (c, n) => {
        if (n > dias.length) return;
        const d = dias[n - 1];
        c.font = { name: LETRA, size: 8, color: c.value === 'Falta' ? { argb: 'FFB42A18' } : undefined, bold: c.value === 'Falta' };
        c.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
        c.border = bordes;
        if (c.value === 'Falta') c.fill = relleno(ROJO_SUAVE);
        else if (diaSemana(d) === 0) c.fill = relleno(PAPEL);
      });
    }
  }

  /* ===================== 4. Reporte de Excepciones ===================== */
  {
    const ws = wb.addWorksheet('Reporte de Excepciones', { views: [{ state: 'frozen', xSplit: 4, ySplit: 5 }] });
    const enc1 = ['ID', 'Nombre', 'Departamento', 'Fecha', 'Primer Horario', '', 'Segundo Horario', '', 'Retardos (Min)', 'Salida Temprano (Min)', 'Comida de más (Min)', 'Falta (Min)', 'Total (Min)', 'Saldo del día', 'Notas'];
    const enc2 = ['', '', '', '', 'Entrada', 'Salida', 'Entrada', 'Salida', '', '', '', '', '', '', ''];
    cabecera(ws, 'Reporte de Excepciones', periodo, enc1.length, logoId);
    ws.getRow(4).values = enc1; ws.getRow(5).values = enc2;
    for (const c of [1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15]) ws.mergeCells(4, c, 5, c);
    ws.mergeCells(4, 5, 4, 6); ws.mergeCells(4, 7, 4, 8);
    estilizarEncabezado(ws.getRow(4)); estilizarEncabezado(ws.getRow(5));
    ws.getRow(4).height = 30;
    [8, 30, 16, 11, 8, 8, 8, 8, 10, 11, 11, 9, 9, 12, 46].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    for (const g of gente) {
      for (const d of dias) {
        const f = porClave.get(`${d}|${g.usuario}`);
        const falta = esFalta(g.p, d, f);
        if (!f && !falta) continue;
        let horas = ['', '', '', ''];
        const notas = [];
        let ret = 0; let temp = 0; let com = 0; let faltaMin = 0; let saldo = '';
        if (f) {
          const c = f.checadas; const n = c.length;
          if (n >= 4) horas = [c[0], c[1], c[2], c[n - 1]];
          else if (n === 3) horas = [c[0], c[1], c[2], ''];
          else if (n === 2) horas = f.tipoDia === 'semana' ? [c[0], '', '', c[1]] : [c[0], c[1], '', ''];
          else horas = [c[0], '', '', ''];
          ret = f.minutosTarde || 0; temp = f.salidaAnticipada || 0; com = f.minutosFueraDeMas || 0;
          if (f.estado === 'incompleto') notas.push('Falta checada de salida (obligatoria)');
          if (f.estado === 'presente' || f.estado === 'comida') notas.push('Jornada en curso');
          if (f.sinComida) notas.push('No checó comida (se descuenta 1 h)');
          if (n > 4) notas.push(`${n} checadas: ${c.join(' ')}`);
          if (f.minutosExtra) notas.push(`Se quedó ${f.minutosExtra} min de más`);
          if (diaSemana(d) === 0) notas.push('Domingo trabajado');
          if (f.saldo != null) saldo = f.saldo < 0 ? `-${hhmm(f.saldo)}` : f.saldo > 0 ? `+${hhmm(f.saldo)}` : '0:00';
        } else {
          faltaMin = minutosEsperados(g.p, d);
          notas.push('Falta: no checó en todo el día');
        }
        const total = ret + temp + com + faltaMin;
        const fila = ws.addRow([g.usuario, g.nombre, g.departamento || '', d, ...horas, ret, temp, com, faltaMin, total, saldo, notas.join('; ')]);
        fila.eachCell({ includeEmpty: true }, (c, n) => {
          c.font = { name: LETRA, size: 9 }; c.border = bordes;
          c.alignment = { horizontal: n <= 3 || n === 15 ? 'left' : 'center', vertical: 'middle', wrapText: n === 15 };
        });
        if (falta) for (let n = 1; n <= 15; n++) fila.getCell(n).fill = relleno(ROJO_SUAVE);
        else if (f && f.estado === 'incompleto') for (let n = 1; n <= 15; n++) fila.getCell(n).fill = relleno(AMBAR_SUAVE);
        if (total) fila.getCell(13).font = { name: LETRA, size: 9, bold: true, color: { argb: 'FFB42A18' } };
        if (saldo) fila.getCell(14).font = { name: LETRA, size: 9, bold: true, color: { argb: saldo.startsWith('-') ? 'FFB42A18' : saldo.startsWith('+') ? 'FF12805A' : NAVY } };
      }
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const nombre = `reporte-asistencia-${desde}${hasta !== desde ? `-al-${hasta}` : ''}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(Buffer.from(buf));
});
