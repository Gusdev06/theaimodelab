/**
 * Parses the duration (in whole seconds) of an MP4 or QuickTime video buffer
 * by reading the moov/mvhd box — no external dependencies required.
 *
 * Throws if the container is not MP4/MOV or if the mvhd box cannot be found.
 */
export function getVideoDurationSeconds(buffer: Buffer): number {
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const boxSize = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);

    if (boxSize < 8) break;

    if (boxType === 'moov') {
      const duration = parseMvhd(buffer, offset + 8, offset + boxSize);
      if (duration !== null) return Math.ceil(duration);
    }

    offset += boxSize;
  }

  throw new Error(
    'Não foi possível determinar a duração do vídeo. Use o formato MP4 ou MOV.',
  );
}

function parseMvhd(
  buffer: Buffer,
  moovStart: number,
  moovEnd: number,
): number | null {
  let offset = moovStart;

  while (offset + 8 <= moovEnd) {
    const boxSize = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);

    if (boxSize < 8) break;

    if (boxType === 'mvhd') {
      const version = buffer.readUInt8(offset + 8);

      if (version === 1) {
        // 64-bit timestamps
        const timescale = buffer.readUInt32BE(offset + 28);
        const durationHi = buffer.readUInt32BE(offset + 32);
        const durationLo = buffer.readUInt32BE(offset + 36);
        const duration = durationHi * 0x100000000 + durationLo;
        return timescale > 0 ? duration / timescale : null;
      } else {
        // 32-bit timestamps
        const timescale = buffer.readUInt32BE(offset + 20);
        const duration = buffer.readUInt32BE(offset + 24);
        return timescale > 0 ? duration / timescale : null;
      }
    }

    offset += boxSize;
  }

  return null;
}
