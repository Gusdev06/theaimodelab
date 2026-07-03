import sharp from 'sharp';

/**
 * Applies a "The AI Model Lab" text watermark to an image buffer using sharp SVG compositing.
 */
export async function applyWatermark(
  imageBuffer: Buffer,
  watermarkText = 'The AI Model Lab',
): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 800;
  const height = metadata.height || 600;

  const fontSize = Math.max(Math.floor(width * 0.06), 16);
  const padding = Math.floor(fontSize * 0.5);

  const svg = `
    <svg width="${width}" height="${height}">
      <style>
        .watermark {
          fill: rgba(255, 255, 255, 0.4);
          font-size: ${fontSize}px;
          font-family: Arial, Helvetica, sans-serif;
          font-weight: bold;
        }
      </style>
      <text
        x="${width - padding}"
        y="${height - padding}"
        text-anchor="end"
        class="watermark"
      >${watermarkText}</text>
    </svg>
  `;

  return sharp(imageBuffer)
    .composite([
      {
        input: Buffer.from(svg),
        gravity: 'southeast',
      },
    ])
    .toBuffer();
}
