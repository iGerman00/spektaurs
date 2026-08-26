/// Compare version numbers, e.g. 1.9.2 < 1.10.0
/// Exact port of spek-utils.cc spek_vercmp
pub fn vercmp(a: &str, b: &str) -> i32 {
    if a.is_empty() && b.is_empty() {
        return 0;
    }
    if a.is_empty() {
        return -1;
    }
    if b.is_empty() {
        return 1;
    }

    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let mut a_pos = 0usize;
    let mut b_pos = 0usize;

    loop {
        let (x, a_next) = strtol(a_bytes, a_pos);
        let (y, b_next) = strtol(b_bytes, b_pos);

        if x < y {
            return -1;
        }
        if x > y {
            return 1;
        }

        let a_end = a_next >= a_bytes.len();
        let b_end = b_next >= b_bytes.len();

        if a_end && b_end {
            return 0;
        }
        if a_end {
            return -1;
        }
        if b_end {
            return 1;
        }

        a_pos = a_next + 1;
        b_pos = b_next + 1;
    }
}

/// Mimic strtol with base 10, return (value, end_index)
/// end_index is index of first character after parsed number, or original pos if no conversion
fn strtol(bytes: &[u8], pos: usize) -> (i64, usize) {
    if pos >= bytes.len() {
        return (0, pos);
    }
    let s = &bytes[pos..];
    // Find end of numeric part: optional leading '-' then digits
    let mut end = 0usize;
    let mut has_digit = false;
    for (i, &c) in s.iter().enumerate() {
        if i == 0 && c == b'-' {
            // sign allowed at start, but need digit after?
            continue;
        } else if c.is_ascii_digit() {
            has_digit = true;
            end = i + 1;
        } else {
            break;
        }
    }
    // Handle case where string is "-" alone => no digit => no conversion
    if !has_digit {
        // Check if first char is digit? If not, strtol returns 0 and endptr = original
        // But also if first char is '-' but no digit after, also no conversion
        // Simplified: if first char not digit and not '-', or is '-' but next not digit, treat as no conversion
        // Our loop above already ensures has_digit false => no conversion
        return (0, pos);
    }
    // If we had sign but has_digit, end already correct
    // For case like "-123", end includes sign + digits, but our end counting includes sign?
    // Actually loop: i=0 c='-' => continue (not counting), i=1 c='1' => end=2, etc. So it counts correctly
    // Need to handle sign length: for "-12", end should be 3 (positions 0:'-',1:'1',2:'2')
    // Our end calculation above: for i=0 '-' we continue, end stays 0, for i=1 '1' end=2, i=2 '2' end=3 => correct
    let num_str = std::str::from_utf8(&s[..end]).unwrap_or("0");
    let val = num_str.parse::<i64>().unwrap_or(0);
    (val, pos + end)
}

#[inline]
pub fn spek_max(a: i32, b: i32) -> i32 {
    if a > b { a } else { b }
}

#[inline]
pub fn spek_min(a: i32, b: i32) -> i32 {
    if a < b { a } else { b }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vercmp_basic() {
        assert_eq!(vercmp("1.0", "1.0"), 0);
        assert_eq!(vercmp("1.0", "1.1"), -1);
        assert_eq!(vercmp("1.1", "1.0"), 1);
        assert_eq!(vercmp("1.9.2", "1.10.0"), -1);
        assert_eq!(vercmp("1.10.0", "1.9.2"), 1);
        assert_eq!(vercmp("", ""), 0);
        assert_eq!(vercmp("", "1"), -1);
        assert_eq!(vercmp("1", ""), 1);
    }

    #[test]
    fn test_vercmp_full_reference() {
        // Exact tests from tests/test-utils.cc
        assert_eq!(vercmp("1.2.3", "1.2.3"), 0);
        assert_eq!(vercmp("1.2.3", "1.2.2"), 1);
        assert_eq!(vercmp("1.2.2", "1.2.3"), -1);
        assert_eq!(vercmp("1.2.3", "1"), 1);
        assert_eq!(vercmp("1.2.3", "1."), 1);
        assert_eq!(vercmp("1.2.3", "1.2"), 1);
        assert_eq!(vercmp("1.2.3", "1.2."), 1);
        assert_eq!(vercmp("1.15.3", "1.2"), 1);
        assert_eq!(vercmp("2", "1.2.2"), 1);
        assert_eq!(vercmp("1.2.3", ""), 1);
        assert_eq!(vercmp("", ""), 0);
        assert_eq!(vercmp("123", "123"), 0);
        assert_eq!(vercmp("0.2.3", "1"), -1);
        assert_eq!(vercmp("0.9.8", "0.10.1"), -1);
        assert_eq!(vercmp("1.200", "2.20"), -1);
        assert_eq!(vercmp("1.0.0", "2.0.0"), -1);
        assert_eq!(vercmp("1.0.0", "1.0.1"), -1);
    }

    #[test]
    fn test_vercmp_additional() {
        // Additional edge cases to ensure parity
        assert_eq!(vercmp("1.0", "1.0.0"), -1); // "1.0" < "1.0.0"
        assert_eq!(vercmp("1.0.0", "1.0"), 1);
        assert_eq!(vercmp("0.10.0", "0.9.0"), 1);
        assert_eq!(vercmp("2.0", "10.0"), -1);
        assert_eq!(vercmp("1.2", "1.10"), -1);
    }
}
