/**
 * Marca invisível "gerado por IA" nas saídas da plataforma (AI Act, art. 50(2): marcação legível por máquina a partir
 * de 02/12/2026; TKT-333).
 *
 * Imagem: grava um pacote XMP com `Iptc4xmpExt:DigitalSourceType = trainedAlgorithmicMedia` (vocabulário da IPTC, o
 * mesmo que Google, Meta e Adobe leem) e `dc:description`/`photoshop:Credit` com o rótulo. O pacote entra direto nos
 * bytes do arquivo (segmento APP1 no JPEG, bloco iTXt no PNG, bloco "XMP " no WebP), SEM recodificar: nenhum pixel
 * muda, a qualidade e a impressão visual (own-media) ficam idênticas.
 *
 * Arquivo que já traz manifesto C2PA do provedor fica como veio: qualquer byte a mais quebraria a assinatura dele, e o
 * C2PA já é a marcação mais forte. Arquivo que já traz o DigitalSourceType de IA também fica como veio.
 *
 * Vídeo: as opções de ffmpeg daqui entram no remux que a subida do MP4 já faz (`-c copy -movflags +faststart`), então
 * não há recodificação nem passada a mais.
 *
 * Nada aqui lança: qualquer arquivo que não dá para marcar volta com os mesmos bytes.
 */

export const AI_PROVENANCE_LABEL = 'AI-generated · The AI Model Lab';
export const IPTC_TRAINED_ALGORITHMIC_MEDIA =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

/** Pastas do storage que guardam saída de geração (o resto, como `inputs/` e `samples/`, é material da cliente). */
const MARKED_FOLDER_PREFIXES = ['generations/', 'video-editor'] as const;

export type AiProvenanceOutcome =
  'marked' | 'already-marked' | 'has-c2pa' | 'unsupported' | 'failed';

export interface AiProvenanceResult {
  buffer: Buffer;
  outcome: AiProvenanceOutcome;
  /** Motivo curto quando não marcou (para o log). */
  reason?: string;
}

/** Flag `AI_PROVENANCE_METADATA`: só liga com "on". Vazio ou qualquer outro valor = desligado. */
export function isAiProvenanceEnabled(
  value: string | undefined | null,
): boolean {
  return (value ?? '').trim().toLowerCase() === 'on';
}

/** A pasta guarda saída de geração? */
export function isGeneratedOutputFolder(folder: string): boolean {
  return MARKED_FOLDER_PREFIXES.some((prefix) => folder.startsWith(prefix));
}

/** Opções extras do ffmpeg para o MP4 (vão junto do `-c copy`, sem recodificar). */
export function aiProvenanceFfmpegOptions(): string[] {
  return [
    '-metadata',
    `comment=${AI_PROVENANCE_LABEL}`,
    '-metadata',
    `description=${AI_PROVENANCE_LABEL} (${IPTC_TRAINED_ALGORITHMIC_MEDIA})`,
  ];
}

export function buildAiProvenanceXmp(): string {
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
    `    Iptc4xmpExt:DigitalSourceType="${IPTC_TRAINED_ALGORITHMIC_MEDIA}"`,
    `    photoshop:Credit="${AI_PROVENANCE_LABEL}">`,
    '   <dc:description>',
    '    <rdf:Alt>',
    `     <rdf:li xml:lang="x-default">${AI_PROVENANCE_LABEL}</rdf:li>`,
    '    </rdf:Alt>',
    '   </dc:description>',
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

/** Grava a marca de IA na imagem (JPEG, PNG ou WebP, detectado pelos bytes). Nunca lança. */
export function embedAiProvenance(buffer: Buffer): AiProvenanceResult {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
      return {
        buffer,
        outcome: 'unsupported',
        reason: 'arquivo vazio ou curto',
      };
    }
    const xmp = Buffer.from(buildAiProvenanceXmp(), 'utf8');
    if (isJpeg(buffer)) return embedInJpeg(buffer, xmp);
    if (isPng(buffer)) return embedInPng(buffer, xmp);
    if (isWebp(buffer)) return embedInWebp(buffer, xmp);
    return { buffer, outcome: 'unsupported', reason: 'formato sem suporte' };
  } catch (error) {
    return {
      buffer,
      outcome: 'failed',
      reason: (error as Error)?.message ?? String(error),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// JPEG: segmento APP1 "http://ns.adobe.com/xap/1.0/\0" + XMP, logo depois dos APP0/APP1 do começo
// ---------------------------------------------------------------------------------------------------------------

const JPEG_XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const JPEG_MAX_SEGMENT_PAYLOAD = 0xffff - 2;

function isJpeg(buffer: Buffer): boolean {
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function embedInJpeg(buffer: Buffer, xmp: Buffer): AiProvenanceResult {
  const payload = Buffer.concat([JPEG_XMP_HEADER, xmp]);
  if (payload.length > JPEG_MAX_SEGMENT_PAYLOAD) {
    return { buffer, outcome: 'failed', reason: 'XMP maior que um segmento' };
  }

  let offset = 2;
  let insertAt = 2;
  let leadingAppRun = true;
  let existingXmp: { start: number; end: number } | null = null;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      return {
        buffer,
        outcome: 'unsupported',
        reason: 'JPEG com estrutura inesperada',
      };
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1; // byte de preenchimento
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // começo da imagem comprimida / fim
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // marcadores sem tamanho
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) {
      return { buffer, outcome: 'unsupported', reason: 'JPEG truncado' };
    }
    const data = buffer.subarray(offset + 4, end);

    if (
      marker === 0xeb &&
      (data.includes('jumb', 0, 'latin1') || data.includes('c2pa', 0, 'latin1'))
    ) {
      return { buffer, outcome: 'has-c2pa' };
    }
    const isXmp =
      marker === 0xe1 &&
      data.subarray(0, JPEG_XMP_HEADER.length).equals(JPEG_XMP_HEADER);
    if (isXmp && !existingXmp) {
      if (data.includes(IPTC_TRAINED_ALGORITHMIC_MEDIA, 0, 'utf8')) {
        return { buffer, outcome: 'already-marked' };
      }
      existingXmp = { start: offset, end };
    }
    // APP0 (JFIF) e APP1 (Exif) precisam vir primeiro; o XMP entra logo depois deles
    if (leadingAppRun && (marker === 0xe0 || (marker === 0xe1 && !isXmp))) {
      insertAt = end;
    } else {
      leadingAppRun = false;
    }
    offset = end;
  }

  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(payload.length + 2, 2);
  const segment = Buffer.concat([header, payload]);

  if (existingXmp) {
    return {
      buffer: Buffer.concat([
        buffer.subarray(0, existingXmp.start),
        segment,
        buffer.subarray(existingXmp.end),
      ]),
      outcome: 'marked',
    };
  }
  return {
    buffer: Buffer.concat([
      buffer.subarray(0, insertAt),
      segment,
      buffer.subarray(insertAt),
    ]),
    outcome: 'marked',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// PNG: bloco iTXt "XML:com.adobe.xmp" logo depois do IHDR
// ---------------------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';

function isPng(buffer: Buffer): boolean {
  return buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

function embedInPng(buffer: Buffer, xmp: Buffer): AiProvenanceResult {
  let offset = 8;
  let afterIhdr = -1;
  let existingXmp: { start: number; end: number } | null = null;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) {
      return { buffer, outcome: 'unsupported', reason: 'PNG truncado' };
    }
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') afterIhdr = end;
    if (type === 'caBX') return { buffer, outcome: 'has-c2pa' };
    if (
      type === 'iTXt' &&
      !existingXmp &&
      data.toString('latin1', 0, PNG_XMP_KEYWORD.length + 1) ===
        `${PNG_XMP_KEYWORD}\0`
    ) {
      if (data.includes(IPTC_TRAINED_ALGORITHMIC_MEDIA, 0, 'utf8')) {
        return { buffer, outcome: 'already-marked' };
      }
      existingXmp = { start: offset, end };
    }
    if (type === 'IEND') break;
    offset = end;
  }

  if (afterIhdr < 0) {
    return { buffer, outcome: 'unsupported', reason: 'PNG sem IHDR' };
  }

  const chunkData = Buffer.concat([
    Buffer.from(`${PNG_XMP_KEYWORD}\0`, 'latin1'),
    Buffer.from([0, 0]), // sem compressão, método 0
    Buffer.from('\0\0', 'latin1'), // idioma e palavra-chave traduzida vazios
    xmp,
  ]);
  const chunk = pngChunk('iTXt', chunkData);

  if (existingXmp) {
    return {
      buffer: Buffer.concat([
        buffer.subarray(0, existingXmp.start),
        chunk,
        buffer.subarray(existingXmp.end),
      ]),
      outcome: 'marked',
    };
  }
  return {
    buffer: Buffer.concat([
      buffer.subarray(0, afterIhdr),
      chunk,
      buffer.subarray(afterIhdr),
    ]),
    outcome: 'marked',
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([header, typeBytes, data, crc]);
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------
// WebP: bloco "XMP " no fim + bandeira de XMP no VP8X (o formato simples ganha um VP8X)
// ---------------------------------------------------------------------------------------------------------------

const WEBP_FLAG_ALPHA = 0x10;
const WEBP_FLAG_XMP = 0x04;

function isWebp(buffer: Buffer): boolean {
  return (
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  );
}

interface RiffChunk {
  fourcc: string;
  start: number;
  /** fim incluindo o byte de alinhamento */
  end: number;
  data: Buffer;
}

function embedInWebp(buffer: Buffer, xmp: Buffer): AiProvenanceResult {
  const riffEnd = Math.min(buffer.length, 8 + buffer.readUInt32LE(4));
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const fourcc = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataEnd = offset + 8 + size;
    if (dataEnd > riffEnd) {
      return { buffer, outcome: 'unsupported', reason: 'WebP truncado' };
    }
    const end = Math.min(riffEnd, dataEnd + (size % 2));
    chunks.push({
      fourcc,
      start: offset,
      end,
      data: buffer.subarray(offset + 8, dataEnd),
    });
    offset = end;
  }
  if (chunks.length === 0)
    return { buffer, outcome: 'unsupported', reason: 'WebP sem blocos' };
  if (chunks.some((chunk) => chunk.fourcc === 'C2PA'))
    return { buffer, outcome: 'has-c2pa' };

  const existingXmp = chunks.find((chunk) => chunk.fourcc === 'XMP ');
  if (existingXmp?.data.includes(IPTC_TRAINED_ALGORITHMIC_MEDIA, 0, 'utf8')) {
    return { buffer, outcome: 'already-marked' };
  }
  const xmpChunk = riffChunk('XMP ', xmp);

  let vp8x: Buffer;
  let body: Buffer[];
  const first = chunks[0];
  if (first.fourcc === 'VP8X') {
    if (first.data.length < 10)
      return { buffer, outcome: 'unsupported', reason: 'VP8X curto' };
    vp8x = Buffer.from(first.data);
    body = chunks
      .slice(1)
      .filter((chunk) => chunk !== existingXmp)
      .map((chunk) => buffer.subarray(chunk.start, chunk.end));
  } else if (
    (first.fourcc === 'VP8 ' || first.fourcc === 'VP8L') &&
    chunks.length === 1
  ) {
    const canvas = simpleWebpCanvas(first);
    if (!canvas)
      return {
        buffer,
        outcome: 'unsupported',
        reason: 'cabeçalho VP8 ilegível',
      };
    vp8x = Buffer.alloc(10);
    vp8x[0] = canvas.alpha ? WEBP_FLAG_ALPHA : 0;
    vp8x.writeUIntLE(canvas.width - 1, 4, 3);
    vp8x.writeUIntLE(canvas.height - 1, 7, 3);
    body = [buffer.subarray(first.start, first.end)];
  } else {
    return {
      buffer,
      outcome: 'unsupported',
      reason: 'WebP com estrutura inesperada',
    };
  }
  vp8x[0] |= WEBP_FLAG_XMP;

  const content = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    riffChunk('VP8X', vp8x),
    ...body,
    xmpChunk,
  ]);
  const riffHeader = Buffer.alloc(8);
  riffHeader.write('RIFF', 0, 'latin1');
  riffHeader.writeUInt32LE(content.length, 4);
  return { buffer: Buffer.concat([riffHeader, content]), outcome: 'marked' };
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

function simpleWebpCanvas(
  chunk: RiffChunk,
): { width: number; height: number; alpha: boolean } | null {
  const data = chunk.data;
  if (chunk.fourcc === 'VP8L') {
    if (data.length < 5 || data[0] !== 0x2f) return null;
    const bits = data.readUInt32LE(1);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      alpha: ((bits >>> 28) & 1) === 1,
    };
  }
  if (
    data.length < 10 ||
    data[3] !== 0x9d ||
    data[4] !== 0x01 ||
    data[5] !== 0x2a
  )
    return null;
  return {
    width: data.readUInt16LE(6) & 0x3fff,
    height: data.readUInt16LE(8) & 0x3fff,
    alpha: false,
  };
}
