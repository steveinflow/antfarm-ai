/**
 * annotate-screenshot.js
 *
 * Renders bounding-box annotations onto a PNG screenshot buffer using sharp + SVG.
 * Each annotation is drawn as a coloured rectangle with a label badge above it,
 * making it immediately clear which part of the UI the design ticket refers to.
 *
 * Exported:
 *   annotateScreenshot(buffer, annotations) → Promise<Buffer>
 *
 * Annotation format (same as ticket.screenshot.annotations):
 *   { x, y, width, height, label }
 *   x/y     — top-left corner in pixels (relative to full-page screenshot)
 *   width/height — bounding box dimensions in pixels
 *   label   — short description (max 40 chars)
 */

// Annotation colours — cycling palette so multiple annotations are distinguishable
const ANNOTATION_COLORS = [
  '#FF4444', // red
  '#FF8800', // orange
  '#22AAFF', // blue
  '#22CC66', // green
  '#AA44FF', // purple
  '#FF44BB', // pink
];

const STROKE_WIDTH = 3;
const LABEL_FONT_SIZE = 12;
const LABEL_PADDING_H = 6; // horizontal padding inside label badge
const LABEL_PADDING_V = 4; // vertical padding inside label badge
const LABEL_HEIGHT = LABEL_FONT_SIZE + LABEL_PADDING_V * 2;
// Approximate character width for Arial 12px (slightly conservative)
const CHAR_WIDTH_APPROX = 7;

/**
 * Escape XML special characters so annotation labels are safe inside SVG text nodes.
 */
function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build an SVG string that draws all annotations over an image of the given dimensions.
 *
 * @param {number} imgWidth  - Image width in pixels
 * @param {number} imgHeight - Image height in pixels
 * @param {Array}  annotations - Array of { x, y, width, height, label }
 * @returns {string} SVG markup
 */
function buildAnnotationSvg(imgWidth, imgHeight, annotations) {
  const shapes = annotations.map((ann, i) => {
    const color = ANNOTATION_COLORS[i % ANNOTATION_COLORS.length];
    const x = Math.max(0, Math.round(ann.x));
    const y = Math.max(0, Math.round(ann.y));
    const w = Math.max(4, Math.round(ann.width));
    const h = Math.max(4, Math.round(ann.height));
    const label = (ann.label || '').slice(0, 40);

    // Estimate badge width from label length
    const badgeW = Math.min(label.length * CHAR_WIDTH_APPROX + LABEL_PADDING_H * 2, imgWidth - x);

    // Position badge above the box; if it would go off the top, place it inside at the top
    const badgeY = y >= LABEL_HEIGHT + 2 ? y - LABEL_HEIGHT - 2 : y + 2;

    // Clamp badge so it doesn't overflow right edge
    const badgeX = Math.min(x, imgWidth - badgeW);

    const numberBadgeSize = 18;
    const numberBadgeX = x;
    const numberBadgeY = y;

    return `
  <!-- Annotation ${i + 1}: ${escXml(label)} -->
  <rect x="${x}" y="${y}" width="${w}" height="${h}"
    fill="none" stroke="${color}" stroke-width="${STROKE_WIDTH}" rx="2" ry="2"
    opacity="0.9"/>
  <!-- Label badge background -->
  <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${LABEL_HEIGHT}"
    fill="${color}" rx="3" ry="3" opacity="0.92"/>
  <!-- Label text -->
  <text x="${badgeX + LABEL_PADDING_H}" y="${badgeY + LABEL_FONT_SIZE + LABEL_PADDING_V - 1}"
    fill="white" font-family="Arial, Helvetica, sans-serif"
    font-size="${LABEL_FONT_SIZE}" font-weight="bold"
    dominant-baseline="auto">${escXml(label)}</text>
  <!-- Corner number badge -->
  <circle cx="${numberBadgeX}" cy="${numberBadgeY}" r="${numberBadgeSize / 2}"
    fill="${color}" opacity="0.92"/>
  <text x="${numberBadgeX}" y="${numberBadgeY + 1}"
    fill="white" font-family="Arial, Helvetica, sans-serif"
    font-size="10" font-weight="bold" text-anchor="middle"
    dominant-baseline="middle">${i + 1}</text>`;
  });

  return `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
${shapes.join('\n')}
</svg>`;
}

/**
 * Render annotation bounding boxes onto a PNG screenshot buffer.
 *
 * If annotations is empty or sharp is unavailable, the original buffer is
 * returned unchanged so callers never need to handle errors from this function.
 *
 * @param {Buffer} buffer       - Raw PNG screenshot buffer (from Playwright)
 * @param {Array}  annotations  - Array of { x, y, width, height, label } objects
 * @returns {Promise<Buffer>}   - Annotated PNG buffer
 */
export async function annotateScreenshot(buffer, annotations) {
  if (!annotations || annotations.length === 0) {
    return buffer;
  }

  let sharp;
  try {
    const mod = await import('sharp');
    sharp = mod.default ?? mod;
  } catch {
    // sharp not installed — return original screenshot silently
    return buffer;
  }

  try {
    const img = sharp(buffer);
    const metadata = await img.metadata();
    const { width, height } = metadata;

    if (!width || !height) {
      return buffer;
    }

    const svgOverlay = buildAnnotationSvg(width, height, annotations);
    const svgBuffer = Buffer.from(svgOverlay, 'utf8');

    const annotated = await sharp(buffer)
      .composite([{ input: svgBuffer, blend: 'over' }])
      .png()
      .toBuffer();

    return annotated;
  } catch (err) {
    // Never fail ticket creation due to annotation rendering errors
    console.error('[annotate-screenshot] Failed to render annotations:', err.message);
    return buffer;
  }
}
