//! Text detection and recognition on a photo, with PP-OCRv5 (PaddlePaddle, Apache-2.0) through ONNX Runtime.
//!
//! Detection (DB): the photo is shrunk to at most `MAX_SIDE` pixels on its long side (sides rounded up to a multiple of 32), the
//! network draws a map of where text is, and every connected blob of that map becomes one line: its direction and size come from
//! the blob's own shape, so a tilted page still gives straight lines. Recognition (CTC): each line is cut out of the *original*
//! photo, turned upright and scaled to 48 pixels tall, and read letter by letter.

use image::{DynamicImage, ImageDecoder, RgbImage};
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

/// The long side the photo is shrunk to for detection. Booklet lyrics are small, so this is larger than the usual 960.
const MAX_SIDE: u32 = 2560;
const MASK_THRESHOLD: f32 = 0.3;
const BOX_THRESHOLD: f32 = 0.6;
const UNCLIP_RATIO: f32 = 1.5;
const REC_HEIGHT: usize = 48;
const MIN_LINE_PIXELS: usize = 24;

/// One line of text found in a photo: its words, how sure the reader is, and where it is (original photo pixels).
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    pub text: String,
    /// 0..1: the reader's mean confidence over the letters.
    pub score: f32,
    /// Centre of the line.
    pub cx: f32,
    pub cy: f32,
    /// Length along the text, and the height across it (the size of the letters).
    pub width: f32,
    pub height: f32,
    /// The direction of the text in radians (0: left to right; a tilted page gives a small angle).
    pub angle: f32,
}

pub struct PageReader {
    detector: Session,
    recognizer: Session,
    /// Index 0 is the CTC blank; the rest are the characters in the model's order (the last is the space).
    characters: Vec<String>,
}

impl PageReader {
    /// `folder` holds `det-inference.onnx`, `rec-inference.onnx` and `rec-inference.yml` (the character list). ONNX Runtime must
    /// already be loaded (`mediaverse_lyric_engine::models::init`).
    pub fn open(folder: &Path) -> Result<Self, String> {
        let load = |name: &str| -> Result<Session, String> {
            let path = folder.join(name);
            if !path.is_file() {
                return Err(format!("{} is missing from {}", name, folder.display()));
            }
            Session::builder()
                .map_err(|e| e.to_string())?
                .commit_from_file(&path)
                .map_err(|e| format!("{}: {e}", path.display()))
        };
        let yml = std::fs::read_to_string(folder.join("rec-inference.yml"))
            .map_err(|e| format!("rec-inference.yml: {e}"))?;
        let characters = characters_from_yml(&yml)?;
        Ok(Self {
            detector: load("det-inference.onnx")?,
            recognizer: load("rec-inference.onnx")?,
            characters,
        })
    }

    /// The text lines of the photo at `path`, in no particular order.
    pub fn read(&mut self, path: &Path) -> Result<Vec<TextLine>, String> {
        let photo = open_upright(path)?;
        let boxes = self.detect(&photo)?;
        let mut lines = Vec::new();
        for found in boxes {
            let (strip, width) = cut_out(&photo, &found);
            if width == 0 {
                continue;
            }
            // For finding out why a line was misread: MEDIAVERSE_PAGE_DEBUG=<folder> saves every line's strip as a picture.
            if let Some(dir) = std::env::var_os("MEDIAVERSE_PAGE_DEBUG") {
                let plane = REC_HEIGHT * width;
                let pixels: Vec<u8> = (0..plane)
                    .flat_map(|i| {
                        [2usize, 1, 0].map(|c| {
                            ((strip[c * plane + i] * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8
                        })
                    })
                    .collect();
                if let Some(picture) = RgbImage::from_raw(width as u32, REC_HEIGHT as u32, pixels) {
                    let _ = picture.save(Path::new(&dir).join(format!(
                        "line-{:04}-{:04}.png",
                        found.cy as u32, found.cx as u32
                    )));
                }
            }
            let (text, score) = self.recognize(strip, width)?;
            let text = text.trim().to_owned();
            if text.is_empty() {
                continue;
            }
            lines.push(TextLine {
                text,
                score,
                cx: found.cx,
                cy: found.cy,
                width: found.width,
                height: found.height,
                angle: found.angle,
            });
        }
        Ok(lines)
    }

    fn detect(&mut self, photo: &RgbImage) -> Result<Vec<Found>, String> {
        let (w, h) = photo.dimensions();
        let scale = (MAX_SIDE as f32 / w.max(h) as f32).min(1.0);
        let round32 = |v: f32| ((v / 32.0).ceil() as u32).max(1) * 32;
        let (dw, dh) = (round32(w as f32 * scale), round32(h as f32 * scale));
        let small = image::imageops::resize(photo, dw, dh, image::imageops::FilterType::Triangle);
        // BGR, scaled and normalised the way PaddleOCR does (its mean and deviation are applied to the channels as they are).
        let (mean, std) = ([0.485f32, 0.456, 0.406], [0.229f32, 0.224, 0.225]);
        let plane = (dw * dh) as usize;
        let mut input = vec![0f32; 3 * plane];
        for (i, pixel) in small.pixels().enumerate() {
            let [r, g, b] = pixel.0;
            for (channel, value) in [b, g, r].into_iter().enumerate() {
                input[channel * plane + i] =
                    (f32::from(value) / 255.0 - mean[channel]) / std[channel];
            }
        }
        let tensor = Tensor::from_array(([1usize, 3, dh as usize, dw as usize], input))
            .map_err(|e| e.to_string())?;
        let outputs = self
            .detector
            .run(ort::inputs![tensor])
            .map_err(|e| e.to_string())?;
        let (_, map) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        Ok(blobs_to_lines(
            map,
            dw as usize,
            dh as usize,
            w as f32 / dw as f32,
            h as f32 / dh as f32,
        ))
    }

    fn recognize(&mut self, strip: Vec<f32>, width: usize) -> Result<(String, f32), String> {
        let tensor = Tensor::from_array(([1usize, 3, REC_HEIGHT, width], strip))
            .map_err(|e| e.to_string())?;
        let outputs = self
            .recognizer
            .run(ort::inputs![tensor])
            .map_err(|e| e.to_string())?;
        let (shape, probs) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let (steps, classes) = (shape[1] as usize, shape[2] as usize);
        Ok(ctc_decode(probs, steps, classes, &self.characters))
    }
}

/// Cuts `boxes` (left, top, right, bottom in photo pixels) out of the photo at `path` as JPEG pictures, each at most `max_side` pixels on its long
/// side: the picture a panel's words were read from, shown beside the words while they are corrected.
pub fn crop_jpegs(path: &Path, boxes: &[[f32; 4]], max_side: u32) -> Result<Vec<Vec<u8>>, String> {
    let photo = open_upright(path)?;
    let (w, h) = photo.dimensions();
    let mut out = Vec::new();
    for b in boxes {
        let x0 = (b[0].max(0.0) as u32).min(w.saturating_sub(1));
        let y0 = (b[1].max(0.0) as u32).min(h.saturating_sub(1));
        let x1 = (b[2].max(0.0) as u32).clamp(x0 + 1, w);
        let y1 = (b[3].max(0.0) as u32).clamp(y0 + 1, h);
        let mut piece = image::imageops::crop_imm(&photo, x0, y0, x1 - x0, y1 - y0).to_image();
        let longest = piece.width().max(piece.height());
        if longest > max_side {
            let scale = max_side as f32 / longest as f32;
            piece = image::imageops::resize(
                &piece,
                ((piece.width() as f32 * scale) as u32).max(1),
                ((piece.height() as f32 * scale) as u32).max(1),
                image::imageops::FilterType::Triangle,
            );
        }
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82)
            .encode_image(&piece)
            .map_err(|e| e.to_string())?;
        out.push(bytes);
    }
    Ok(out)
}

/// The photo with the camera's rotation applied, then turned a further `turn` degrees clockwise (0, 90, 180 or 270).
fn upright_turned(path: &Path, turn: u32) -> Result<RgbImage, String> {
    let photo = open_upright(path)?;
    Ok(match turn % 360 {
        90 => image::imageops::rotate90(&photo),
        180 => image::imageops::rotate180(&photo),
        270 => image::imageops::rotate270(&photo),
        _ => photo,
    })
}

/// A picture as a JPEG, at most `max_side` pixels on the long side.
fn jpeg_at_most(mut picture: RgbImage, max_side: u32, quality: u8) -> Result<Vec<u8>, String> {
    let longest = picture.width().max(picture.height());
    if longest > max_side {
        let scale = max_side as f32 / longest as f32;
        picture = image::imageops::resize(
            &picture,
            ((picture.width() as f32 * scale) as u32).max(1),
            ((picture.height() as f32 * scale) as u32).max(1),
            image::imageops::FilterType::Triangle,
        );
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(&picture)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// The photo as a JPEG for the vision reader or for showing: the camera's rotation applied, then turned a further `turn` degrees clockwise
/// (0, 90, 180 or 270: the person's own "rotate" choice for a page photographed sideways), at most `max_side` pixels on the long side.
pub fn prepared_jpeg(
    path: &Path,
    turn: u32,
    max_side: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    jpeg_at_most(upright_turned(path, turn)?, max_side, quality)
}

/// One part of the turned photo as a JPEG: `part` is left, top, right, bottom as fractions (0 to 1) of the turned photo, grown by `margin`
/// (a fraction too) on every side. The picture shown beside a song's words.
pub fn part_jpeg(
    path: &Path,
    turn: u32,
    part: [f32; 4],
    margin: f32,
    max_side: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let photo = upright_turned(path, turn)?;
    let (w, h) = photo.dimensions();
    let x0 = (((part[0] - margin).max(0.0)) * w as f32) as u32;
    let y0 = (((part[1] - margin).max(0.0)) * h as f32) as u32;
    let x1 = (((part[2] + margin).min(1.0)) * w as f32) as u32;
    let y1 = (((part[3] + margin).min(1.0)) * h as f32) as u32;
    let (x0, y0) = (x0.min(w.saturating_sub(2)), y0.min(h.saturating_sub(2)));
    let (x1, y1) = (x1.clamp(x0 + 1, w), y1.clamp(y0 + 1, h));
    let piece = image::imageops::crop_imm(&photo, x0, y0, x1 - x0, y1 - y0).to_image();
    jpeg_at_most(piece, max_side, quality)
}

/// The photo with the camera's rotation applied (phones store the picture sideways and say how to turn it).
fn open_upright(path: &Path) -> Result<RgbImage, String> {
    let reader = image::ImageReader::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut decoder = reader
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_decoder()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let orientation = decoder.orientation().ok();
    let mut photo =
        DynamicImage::from_decoder(decoder).map_err(|e| format!("{}: {e}", path.display()))?;
    if let Some(orientation) = orientation {
        photo.apply_orientation(orientation);
    }
    Ok(photo.to_rgb8())
}

/// A line found by detection, before it is read: centre, length, height and direction in photo pixels.
#[derive(Debug, Clone, Copy)]
struct Found {
    cx: f32,
    cy: f32,
    width: f32,
    height: f32,
    angle: f32,
}

/// Every connected blob of the probability map becomes a line (a rotated rectangle from the blob's own shape).
fn blobs_to_lines(map: &[f32], w: usize, h: usize, sx: f32, sy: f32) -> Vec<Found> {
    let mut seen = vec![false; w * h];
    let mut found = Vec::new();
    let mut stack = Vec::new();
    for start in 0..w * h {
        if seen[start] || map[start] <= MASK_THRESHOLD {
            continue;
        }
        let mut points: Vec<(f32, f32)> = Vec::new();
        let mut sum = 0f32;
        stack.push(start);
        seen[start] = true;
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            points.push((x as f32, y as f32));
            sum += map[i];
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let n = ny as usize * w + nx as usize;
                    if !seen[n] && map[n] > MASK_THRESHOLD {
                        seen[n] = true;
                        stack.push(n);
                    }
                }
            }
        }
        if points.len() < MIN_LINE_PIXELS || sum / points.len() as f32 <= BOX_THRESHOLD {
            continue;
        }
        if let Some(line) = oriented_box(&points) {
            // back to photo pixels (the map was drawn on a shrunk copy; sx and sy are nearly equal)
            let s = (sx + sy) / 2.0;
            found.push(Found {
                cx: line.cx * sx,
                cy: line.cy * sy,
                width: line.width * s,
                height: line.height * s,
                angle: line.angle,
            });
        }
    }
    found
}

/// The rotated rectangle around a blob (its long direction from the spread of its points), grown outwards as the text detector's
/// maps are drawn smaller than the letters (`UNCLIP_RATIO`).
fn oriented_box(points: &[(f32, f32)]) -> Option<Found> {
    let n = points.len() as f32;
    let (mx, my) = (
        points.iter().map(|p| p.0).sum::<f32>() / n,
        points.iter().map(|p| p.1).sum::<f32>() / n,
    );
    let (mut cxx, mut cyy, mut cxy) = (0f32, 0f32, 0f32);
    for &(x, y) in points {
        let (dx, dy) = (x - mx, y - my);
        cxx += dx * dx;
        cyy += dy * dy;
        cxy += dx * dy;
    }
    let mut angle = 0.5 * (2.0 * cxy).atan2(cxx - cyy);
    // keep the direction within a quarter turn of level: text that reads upwards or downwards is not expected
    if angle > std::f32::consts::FRAC_PI_2 {
        angle -= std::f32::consts::PI;
    }
    let (ux, uy) = (angle.cos(), angle.sin());
    let (vx, vy) = (-uy, ux);
    let (mut u0, mut u1, mut v0, mut v1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for &(x, y) in points {
        let (u, v) = ((x - mx) * ux + (y - my) * uy, (x - mx) * vx + (y - my) * vy);
        u0 = u0.min(u);
        u1 = u1.max(u);
        v0 = v0.min(v);
        v1 = v1.max(v);
    }
    let (w, h) = (u1 - u0 + 1.0, v1 - v0 + 1.0);
    let grow = (w * h * UNCLIP_RATIO) / (2.0 * (w + h));
    let (w, h) = (w + 2.0 * grow, h + 2.0 * grow);
    // centre of the box (not of the points)
    let (cu, cv) = ((u0 + u1) / 2.0, (v0 + v1) / 2.0);
    let (cx, cy) = (mx + cu * ux + cv * vx, my + cu * uy + cv * vy);
    if w < 4.0 || h < 4.0 {
        return None;
    }
    // a blob taller than long is a vertical line: turn it so the long side is the text direction
    if h > w * 1.5 {
        return Some(Found {
            cx,
            cy,
            width: h,
            height: w,
            angle: angle + std::f32::consts::FRAC_PI_2,
        });
    }
    Some(Found {
        cx,
        cy,
        width: w,
        height: h,
        angle,
    })
}

/// The line cut out of the photo, upright, 48 pixels tall, as the recogniser's input (BGR, scaled to -1..1, channels first).
fn cut_out(photo: &RgbImage, line: &Found) -> (Vec<f32>, usize) {
    let width = ((REC_HEIGHT as f32 * line.width / line.height).ceil() as usize).clamp(8, 3200);
    let (ux, uy) = (line.angle.cos(), line.angle.sin());
    let (vx, vy) = (-uy, ux);
    let (pw, ph) = (photo.width() as i32, photo.height() as i32);
    let plane = REC_HEIGHT * width;
    let mut out = vec![0f32; 3 * plane];
    for row in 0..REC_HEIGHT {
        for col in 0..width {
            let u = ((col as f32 + 0.5) / width as f32 - 0.5) * line.width;
            let v = ((row as f32 + 0.5) / REC_HEIGHT as f32 - 0.5) * line.height;
            let (x, y) = (line.cx + u * ux + v * vx, line.cy + u * uy + v * vy);
            // bilinear sample
            let (x0, y0) = (x.floor(), y.floor());
            let (fx, fy) = (x - x0, y - y0);
            let at = |ix: i32, iy: i32| {
                photo
                    .get_pixel(ix.clamp(0, pw - 1) as u32, iy.clamp(0, ph - 1) as u32)
                    .0
            };
            let (p00, p10, p01, p11) = (
                at(x0 as i32, y0 as i32),
                at(x0 as i32 + 1, y0 as i32),
                at(x0 as i32, y0 as i32 + 1),
                at(x0 as i32 + 1, y0 as i32 + 1),
            );
            for (channel, source) in [2usize, 1, 0].into_iter().enumerate() {
                let value = f32::from(p00[source]) * (1.0 - fx) * (1.0 - fy)
                    + f32::from(p10[source]) * fx * (1.0 - fy)
                    + f32::from(p01[source]) * (1.0 - fx) * fy
                    + f32::from(p11[source]) * fx * fy;
                out[channel * plane + row * width + col] = (value / 255.0 - 0.5) / 0.5;
            }
        }
    }
    (out, width)
}

/// Greedy CTC reading: the most likely letter at every step, repeats merged, blanks dropped. The score is the mean confidence of
/// the letters kept.
fn ctc_decode(probs: &[f32], steps: usize, classes: usize, characters: &[String]) -> (String, f32) {
    let mut text = String::new();
    let (mut last, mut total, mut kept) = (usize::MAX, 0f32, 0u32);
    for step in 0..steps {
        let row = &probs[step * classes..(step + 1) * classes];
        let (best, value) =
            row.iter().enumerate().fold(
                (0usize, f32::MIN),
                |acc, (i, &v)| if v > acc.1 { (i, v) } else { acc },
            );
        if best != 0 && best != last {
            if let Some(c) = characters.get(best) {
                text.push_str(c);
                total += value;
                kept += 1;
            }
        }
        last = best;
    }
    (text, if kept == 0 { 0.0 } else { total / kept as f32 })
}

/// The character list of the recogniser's settings file (`PostProcess: character_dict:` and its `- x` entries), with the blank first
/// and the space last, which is how the network numbers its outputs.
pub fn characters_from_yml(yml: &str) -> Result<Vec<String>, String> {
    let mut list = vec![String::new()]; // blank
    let mut inside = false;
    for line in yml.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim_end() == "  character_dict:" {
            inside = true;
            continue;
        }
        if !inside {
            continue;
        }
        let Some(item) = line
            .strip_prefix("  - ")
            .or_else(|| line.strip_prefix("- "))
        else {
            if line.trim().is_empty() {
                continue;
            }
            break; // the next setting
        };
        // The text is taken exactly (a full-width space is a character here, not padding).
        let entry = if let Some(inner) = item.strip_prefix('\'').and_then(|s| s.strip_suffix('\''))
        {
            inner.replace("''", "'")
        } else if let Some(inner) = item.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            inner.replace("\\\\", "\\").replace("\\\"", "\"")
        } else {
            item.to_owned()
        };
        list.push(entry);
    }
    if list.len() < 100 {
        return Err("rec-inference.yml has no character list".to_owned());
    }
    list.push(" ".to_owned());
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_character_list_keeps_odd_entries_whole() {
        let mut yml = String::from(
            "PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - 　\n  - '!'\n  - ''''\n  - \"\\\\\"\n  - a\n",
        );
        for i in 0..120 {
            yml.push_str(&format!("  - {}\n", char::from_u32(0x4e00 + i).unwrap()));
        }
        yml.push_str("Other:\n  x: 1\n");
        let list = characters_from_yml(&yml).unwrap();
        assert_eq!(list[0], "", "blank first");
        assert_eq!(&list[1], "　");
        assert_eq!(&list[2], "!");
        assert_eq!(&list[3], "'");
        assert_eq!(&list[4], "\\");
        assert_eq!(&list[5], "a");
        assert_eq!(list.last().unwrap(), " ", "space last");
        assert_eq!(list.len(), 1 + 5 + 120 + 1);
    }

    #[test]
    fn ctc_merges_repeats_and_drops_blanks() {
        let characters: Vec<String> = ["", "a", "b", " "]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        // steps: a a blank a b b  -> "aab"
        let rows: [[f32; 4]; 6] = [
            [0.0, 0.9, 0.0, 0.1],
            [0.0, 0.8, 0.1, 0.1],
            [0.9, 0.0, 0.0, 0.1],
            [0.0, 0.7, 0.2, 0.1],
            [0.0, 0.1, 0.8, 0.1],
            [0.0, 0.1, 0.9, 0.0],
        ];
        let flat: Vec<f32> = rows.iter().flatten().copied().collect();
        let (text, score) = ctc_decode(&flat, 6, 4, &characters);
        assert_eq!(text, "aab");
        assert!((score - (0.9 + 0.7 + 0.8) / 3.0).abs() < 1e-6);
    }

    #[test]
    fn a_tilted_blob_gives_a_tilted_line() {
        // a thin diagonal bar of points, about 3 degrees below level
        let angle = 3f32.to_radians();
        let points: Vec<(f32, f32)> = (0..200)
            .flat_map(|i| {
                (0..6).map(move |j| {
                    let (u, v) = (i as f32, j as f32);
                    (
                        100.0 + u * angle.cos() - v * angle.sin(),
                        50.0 + u * angle.sin() + v * angle.cos(),
                    )
                })
            })
            .collect();
        let line = oriented_box(&points).unwrap();
        assert!((line.angle - angle).abs() < 0.02, "angle {}", line.angle);
        assert!(line.width > line.height * 5.0);
    }
}
