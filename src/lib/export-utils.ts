import * as XLSX from 'xlsx';

export type ExportFormat = 'xlsx' | 'csv';

interface ExportOptions {
  filename: string;
  sheetName?: string;
  headers: (string | null | undefined)[][];
  data: (string | number | null | undefined)[][];
  format: ExportFormat;
}

/**
 * Export tabular data to xlsx or csv file.
 * Handles file creation, column auto-sizing, and browser download.
 */
export function exportToFile({ filename, sheetName = 'Sheet1', headers, data, format }: ExportOptions) {
  const allRows = [...headers, ...data];
  const ws = XLSX.utils.aoa_to_sheet(allRows);

  // Auto-size columns based on content width
  if (allRows.length > 0 && allRows[0]) {
    const colWidths = allRows[0].map((_, colIdx) => {
      let max = 8;
      for (const row of allRows) {
        const cell = row[colIdx];
        const len = cell != null ? String(cell).length : 0;
        if (len > max) max = len;
      }
      return { wch: Math.min(max + 2, 30) };
    });
    ws['!cols'] = colWidths;
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  if (format === 'csv') {
    XLSX.writeFile(wb, `${filename}.csv`, { bookType: 'csv' });
  } else {
    XLSX.writeFile(wb, `${filename}.xlsx`, { bookType: 'xlsx' });
  }
}
