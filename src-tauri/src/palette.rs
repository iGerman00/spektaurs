use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Palette {
    Spectrum = 0,
    #[default]
    Sox = 1,
    Mono = 2,
}

impl Palette {
    pub fn from_index(idx: i32) -> Self {
        match idx {
            0 => Palette::Spectrum,
            1 => Palette::Sox,
            2 => Palette::Mono,
            _ => Palette::Sox,
        }
    }

    pub fn to_index(self) -> i32 {
        self as i32
    }

    pub fn name(&self) -> &'static str {
        match self {
            Palette::Spectrum => "Spectrum",
            Palette::Sox => "SoX",
            Palette::Mono => "Mono",
        }
    }
}

/// Port of spek-palette.cc
pub fn palette_color(palette: Palette, level: f64) -> u32 {
    match palette {
        Palette::Spectrum => spectrum(level),
        Palette::Sox => sox(level),
        Palette::Mono => mono(level),
    }
}

fn spectrum(mut level: f64) -> u32 {
    level *= 0.6625;
    let (mut r, mut g, mut b) = (0.0, 0.0, 0.0);
    if (0.0..0.15).contains(&level) {
        r = (0.15 - level) / (0.15 + 0.075);
        g = 0.0;
        b = 1.0;
    } else if (0.15..0.275).contains(&level) {
        r = 0.0;
        g = (level - 0.15) / (0.275 - 0.15);
        b = 1.0;
    } else if (0.275..0.325).contains(&level) {
        r = 0.0;
        g = 1.0;
        b = (0.325 - level) / (0.325 - 0.275);
    } else if (0.325..0.5).contains(&level) {
        r = (level - 0.325) / (0.5 - 0.325);
        g = 1.0;
        b = 0.0;
    } else if (0.5..0.6625).contains(&level) {
        r = 1.0;
        g = (0.6625 - level) / (0.6625 - 0.5);
        b = 0.0;
    }

    let mut cf = 1.0;
    if (0.0..0.1).contains(&level) {
        cf = level / 0.1;
    }
    cf *= 255.0;

    let rr = (r * cf + 0.5) as u32;
    let gg = (g * cf + 0.5) as u32;
    let bb = (b * cf + 0.5) as u32;
    (rr << 16) + (gg << 8) + bb
}

fn sox(level: f64) -> u32 {
    let r = if (0.13..0.73).contains(&level) {
        ((level - 0.13) / 0.60 * std::f64::consts::PI / 2.0).sin()
    } else if level >= 0.73 {
        1.0
    } else {
        0.0
    };

    let g = if (0.6..0.91).contains(&level) {
        ((level - 0.6) / 0.31 * std::f64::consts::PI / 2.0).sin()
    } else if level >= 0.91 {
        1.0
    } else {
        0.0
    };

    let b = if level < 0.60 {
        0.5 * (level / 0.6 * std::f64::consts::PI).sin()
    } else if level >= 0.78 {
        (level - 0.78) / 0.22
    } else {
        0.0
    };

    let rr = (r * 255.0 + 0.5) as u32;
    let gg = (g * 255.0 + 0.5) as u32;
    let bb = (b * 255.0 + 0.5) as u32;
    (rr << 16) + (gg << 8) + bb
}

fn mono(level: f64) -> u32 {
    let v = (level * 255.0 + 0.5) as u32;
    (v << 16) + (v << 8) + v
}

pub fn palette_to_rgb(palette: Palette, level: f64) -> (u8, u8, u8) {
    let c = palette_color(palette, level);
    (((c >> 16) & 0xFF) as u8, ((c >> 8) & 0xFF) as u8, (c & 0xFF) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_palette_bounds() {
        for p in [Palette::Spectrum, Palette::Sox, Palette::Mono] {
            let c0 = palette_color(p, 0.0);
            let c1 = palette_color(p, 1.0);
            // should be valid colors
            assert!(c0 <= 0xFFFFFF);
            assert!(c1 <= 0xFFFFFF);
        }
    }

    #[test]
    fn test_palette_reference_sox() {
        // Reference values from C++ spek-palette.cc via /tmp/palette_test
        let cases: Vec<(Palette, f64, u32)> = vec![
            (Palette::Spectrum, 0.0, 0x000000),
            (Palette::Spectrum, 0.13, 0x3e00dc),
            (Palette::Spectrum, 0.25, 0x0020ff),
            (Palette::Spectrum, 0.50, 0x09ff00),
            (Palette::Spectrum, 0.60, 0x6aff00),
            (Palette::Spectrum, 0.73, 0xe7ff00),
            (Palette::Spectrum, 0.78, 0xffe500),
            (Palette::Spectrum, 0.91, 0xff5e00),
            (Palette::Spectrum, 1.0, 0x000000),
            (Palette::Sox, 0.0, 0x000000),
            (Palette::Sox, 0.13, 0x000050),
            (Palette::Sox, 0.25, 0x4f007b),
            (Palette::Sox, 0.50, 0xd20040),
            (Palette::Sox, 0.60, 0xf00000),
            (Palette::Sox, 0.73, 0xff9c00),
            (Palette::Sox, 0.78, 0xffca00),
            (Palette::Sox, 0.91, 0xffff97),
            (Palette::Sox, 1.0, 0xffffff),
            (Palette::Mono, 0.0, 0x000000),
            (Palette::Mono, 0.13, 0x212121),
            (Palette::Mono, 0.25, 0x404040),
            (Palette::Mono, 0.50, 0x808080),
            (Palette::Mono, 0.60, 0x999999),
            (Palette::Mono, 0.73, 0xbababa),
            (Palette::Mono, 0.78, 0xc7c7c7),
            (Palette::Mono, 0.91, 0xe8e8e8),
            (Palette::Mono, 1.0, 0xffffff),
        ];
        for (pal, level, expected) in cases {
            let got = palette_color(pal, level);
            assert_eq!(got, expected, "palette {:?} level {} expected {:06x} got {:06x}", pal, level, expected, got);
        }
    }

    #[test]
    fn test_palette_mono_linear() {
        // Mono is linear grayscale
        for i in 0..=10 {
            let level = i as f64 / 10.0;
            let c = palette_color(Palette::Mono, level);
            let v = ((c >> 16) & 0xFF) as u8;
            // All channels equal
            assert_eq!((c >> 16) & 0xFF, (c >> 8) & 0xFF);
            assert_eq!((c >> 8) & 0xFF, c & 0xFF);
            let expected = (level * 255.0 + 0.5) as u32;
            assert_eq!(v as u32, expected, "level {}", level);
        }
    }
}
