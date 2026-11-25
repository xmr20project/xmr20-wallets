//! Parity tests (texts and records): the Rust reading of open deploys against the JavaScript one, case by case.
//! The cases and the JavaScript verdicts are written by review-parity/gen.mjs (node gen.mjs in that folder):
//!   codepoints.json  every code point alone / after a letter / before a letter / between letters in a ticker, and in a name
//!   contents.json    deploy texts: hand-picked edge cases and mutations, with what readOpenDeploy makes of each
//!   labels.json      ticker fields and labels
//!   records.json     whole MD1 records with throwaway signatures, with what the XMR721 rules make of each
//! A test fails when the two sides disagree on any case and prints the first disagreements.
//! Run: cargo test --release --offline review_text_tests
use super::*;
use crate::address::MAINNET;
use crate::open::{self, Deploy, Text};
use serde_json::Value as J;

fn load(name: &str) -> J {
    let p = format!("{}/../review-parity/{}", env!("CARGO_MANIFEST_DIR"), name);
    serde_json::from_slice(&std::fs::read(&p).unwrap_or_else(|_| panic!("{p}: run node gen.mjs in review-parity"))).unwrap()
}
/// UTF-8 of any code point, surrogates included (as gen.mjs writes them).
fn utf8(cp: u32) -> Vec<u8> {
    match cp {
        0..=0x7f => vec![cp as u8],
        0x80..=0x7ff => vec![0xc0 | (cp >> 6) as u8, 0x80 | (cp & 63) as u8],
        0x800..=0xffff => vec![0xe0 | (cp >> 12) as u8, 0x80 | (cp >> 6 & 63) as u8, 0x80 | (cp & 63) as u8],
        _ => vec![0xf0 | (cp >> 18) as u8, 0x80 | (cp >> 12 & 63) as u8, 0x80 | (cp >> 6 & 63) as u8, 0x80 | (cp & 63) as u8],
    }
}

#[test]
fn every_code_point_is_read_the_same() {
    let f = load("codepoints.json");
    let maps: Vec<Vec<u8>> = f["maps"].as_array().unwrap().iter().map(|m| hex::decode(m.as_str().unwrap()).unwrap()).collect();
    assert_eq!(maps.len(), 5);
    let head: &[u8] = br#"{"p":"xmr20","op":"deploy","tick":""#;
    let nhead: &[u8] = br#"{"p":"xmr20","op":"deploy","tick":"T","name":""#;
    let tail: &[u8] = br#"","max":"5","dec":"6","mode":"open","lim":"1"}"#;
    let (mut bad, mut allowed, mut cases) = (vec![], 0u64, 0u64);
    for cp in 0..0x110000u32 {
        let c = utf8(cp);
        let shapes: [Vec<&[u8]>; 5] = [vec![head, &c, tail], vec![head, b"a", &c, tail], vec![head, &c, b"a", tail], vec![head, b"a", &c, b"a", tail], vec![nhead, &c, tail]];
        for (i, s) in shapes.iter().enumerate() {
            let js = maps[i][(cp >> 3) as usize] >> (cp & 7) & 1 == 1;
            let rust = Text::read(&s.concat()).is_some();
            cases += 1;
            if i == 0 && rust {
                allowed += 1;
            }
            if js != rust && bad.len() < 20 {
                bad.push(format!("U+{cp:04X} shape {i}: JavaScript {js}, Rust {rust}"));
            }
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
    assert_eq!(allowed, f["allowed"].as_u64().unwrap());
    println!("code point cases: {cases}, allowed alone in a ticker: {allowed}");
}

#[test]
fn every_text_is_read_the_same() {
    let f = load("contents.json");
    let (mut bad, mut ok, mut n) = (vec![], 0, 0);
    for c in f.as_array().unwrap() {
        let bytes = hex::decode(c["h"].as_str().unwrap()).unwrap();
        let (js, rust) = (c["ok"].as_bool().unwrap(), Text::read(&bytes));
        n += 1;
        if js != rust.is_some() {
            if bad.len() < 20 {
                bad.push(format!("JavaScript {js}, Rust {}: {} ({})", rust.is_some(), String::from_utf8_lossy(&bytes), c["h"]));
            }
            continue;
        }
        if let Some(t) = rust {
            ok += 1;
            // What is read is what was written, to the byte, and the ticker and its field are the same on both sides.
            assert_eq!(t.write().unwrap().as_bytes(), bytes);
            assert_eq!(t.tick, c["tick"].as_str().unwrap());
            assert_eq!(open::ticker_field(&t.tick), c["field"].as_str().unwrap());
            assert!(bytes.len() <= 597, "a text longer than the longest one there is");
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
    println!("texts: {n}, read as a deploy by both: {ok}");
}

#[test]
fn ticker_fields_and_labels_are_the_same() {
    let f = load("labels.json");
    for c in f.as_array().unwrap() {
        let (t, id): (&str, [u8; 32]) = (c["t"].as_str().unwrap(), hex::decode(c["id"].as_str().unwrap()).unwrap().try_into().unwrap());
        assert_eq!(open::ticker_field(t), c["field"].as_str().unwrap(), "{t:?}");
        assert_eq!(open::label(t, &id), c["label"].as_str().unwrap(), "{t:?}");
    }
    println!("labels: {}", f.as_array().unwrap().len());
}

#[test]
fn every_record_is_read_the_same() {
    let f = load("records.json");
    let domain: [u8; 32] = hex::decode(f["domain"].as_str().unwrap()).unwrap().try_into().unwrap();
    let (mut bad, mut ok, mut n) = (vec![], 0, 0);
    for c in f["cases"].as_array().unwrap() {
        let bytes = hex::decode(c["h"].as_str().unwrap()).unwrap();
        let js = c["ok"].as_bool().unwrap();
        // What the pool asks of an MD1 record before it is an open deploy (apply_carrier).
        let d = Deploy::decode(&bytes).ok().filter(|d| d.verify_sig(&domain, MAINNET).is_ok());
        n += 1;
        if js != d.is_some() {
            if bad.len() < 20 {
                bad.push(format!("{}: JavaScript {js} ({}), Rust {}: {}", c["note"], c["why"], d.is_some(), c["h"]));
            }
            continue;
        }
        if let Some(d) = d {
            ok += 1;
            let id = d.id(&domain).unwrap();
            assert_eq!(hex::encode(id), c["id"].as_str().unwrap());
            assert_eq!(d.signed_text(&domain, MAINNET).unwrap(), c["text"].as_str().unwrap());
            assert_eq!(d.creator.encode(MAINNET), c["creator"].as_str().unwrap());
            assert_eq!(d.text.tick, c["tick"].as_str().unwrap());
            assert_eq!(open::ticker_field(&d.text.tick), c["field"].as_str().unwrap());
            assert_eq!(open::label(&d.text.tick, &id), c["label"].as_str().unwrap());
            assert_eq!(d.encode().unwrap(), bytes);
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
    println!("records: {n}, open deploys for both: {ok}");
}

/// Both sides refuse a key written in a way other than the one way (y at or above the field prime), but for different
/// reasons: the JavaScript library refuses the bytes, this side reads them as the point they stand for and then finds
/// every one of the 19 such points outside the main group or neutral. This holds for Curve25519 as a matter of fact;
/// the test pins it, so that the agreement is not an accident nobody looked at.
#[test]
fn no_usable_key_is_written_two_ways() {
    use curve25519_dalek::{edwards::CompressedEdwardsY, traits::IsIdentity};
    let p_minus_19: [u8; 32] = {
        let mut b = [0xffu8; 32];
        b[0] = 0xed;
        b[31] = 0x7f;
        b
    };
    for y in 0u8..19 {
        for sign in [0u8, 0x80] {
            let mut b = p_minus_19;
            b[0] += y; // p + y, never carries (0xed + 18 = 0xff)
            b[31] |= sign;
            if let Some(pt) = CompressedEdwardsY(b).decompress() {
                assert!(pt.is_identity() || !pt.is_torsion_free(), "a usable key with a second encoding: {}", hex::encode(b));
                assert_ne!(pt.compress().0, b);
            }
        }
    }
    // The neutral point and the point of order 2 with the sign bit set: read here, refused as bytes in JavaScript.
    for h in ["0100000000000000000000000000000000000000000000000000000000000080", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] {
        let b: [u8; 32] = hex::decode(h).unwrap().try_into().unwrap();
        let pt = CompressedEdwardsY(b).decompress().expect("read as a point");
        assert!(pt.is_identity() || !pt.is_torsion_free());
    }
}

/// The transaction field that carries a record is read by two parsers: the XMR721 reader's `unframe`
/// (reader/lib/transport.mjs) and `transport::unframe_open` here. Both take an MD1 record in one order only (transaction key
/// first, then a payment id, then the chunks), as RULES.md section 8 says. If this side took any order,
/// a deploy carried another way would be a token here and no inscription there.
#[test]
fn the_carrier_field_is_read_the_same() {
    use crate::transport;
    let f = load("extras.json");
    let domain: [u8; 32] = hex::decode(f["domain"].as_str().unwrap()).unwrap().try_into().unwrap();
    let (mut differ, mut same, mut both) = (std::collections::BTreeMap::<String, usize>::new(), 0, 0);
    for c in f["cases"].as_array().unwrap() {
        let extra = hex::decode(c["h"].as_str().unwrap()).unwrap();
        let js = c["ok"].as_bool().unwrap();
        let record = transport::unframe_open(&extra).ok().flatten();
        let d = record.and_then(|b| Deploy::decode(&b).ok()).filter(|d| d.verify_sig(&domain, MAINNET).is_ok());
        if js == d.is_some() {
            same += 1;
            if let Some(d) = d {
                both += 1;
                assert_eq!(hex::encode(d.id(&domain).unwrap()), c["id"].as_str().unwrap());
            }
        } else {
            assert!(!js, "the XMR721 reader takes a deploy this ledger does not: {} {}", c["note"], c["h"]);
            *differ.entry(c["note"].as_str().unwrap().to_string()).or_default() += 1;
        }
    }
    println!("carrier fields: {} the same ({both} deploys for both); a token here and nothing for the XMR721 reader: {differ:#?}", same);
    assert!(both >= 6);
    assert!(differ.is_empty(), "{differ:#?}");
}
