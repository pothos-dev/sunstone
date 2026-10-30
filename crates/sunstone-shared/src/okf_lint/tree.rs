//! A positioned YAML tree for the Frontmatter lint: every node keeps the
//! source range it was written at, which `serde_yaml` cannot give (ADR 0009).
//!
//! Built from `saphyr-parser` events. Ranges are CHARACTER indices into the
//! block (the parser's unit); [`super::lint_frontmatter`] converts them to the
//! caller's units at the end. Plain scalars resolve by the YAML 1.2 core schema,
//! as the editor's `yaml` package does: `2026-06-30` stays a string, `1984` is a
//! number, `yes` is a string.

use saphyr_parser::{Event, Parser, ScalarStyle, Span};

/// A `[from, to)` character range into the YAML block.
pub type Range = (usize, usize);

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
}

#[derive(Debug)]
pub enum Kind {
    Scalar(Value),
    Map(Vec<Pair>),
    Seq(Vec<Node>),
    /// An alias (`*a`): never inspected, only positioned.
    Alias,
}

#[derive(Debug)]
pub struct Node {
    pub kind: Kind,
    pub range: Range,
}

#[derive(Debug)]
pub struct Pair {
    pub key: Node,
    pub value: Node,
}

/// A problem found while building the tree.
#[derive(Debug, PartialEq)]
pub enum Problem {
    /// The block does not parse; nothing after `at` was read.
    Syntax { at: usize, message: String },
    /// A key repeated in one mapping, at the repeat.
    DuplicateKey { range: Range, key: String },
}

/// The parsed block: its top-level node (`None` when empty or only comments)
/// and every problem met on the way.
pub struct Document {
    pub root: Option<Node>,
    pub problems: Vec<Problem>,
}

impl Document {
    pub fn malformed(&self) -> bool {
        self.problems.iter().any(|p| matches!(p, Problem::Syntax { .. }))
    }
}

impl Node {
    pub fn is_map(&self) -> bool {
        matches!(self.kind, Kind::Map(_))
    }
    pub fn is_seq(&self) -> bool {
        matches!(self.kind, Kind::Seq(_))
    }
    pub fn is_scalar(&self) -> bool {
        matches!(self.kind, Kind::Scalar(_))
    }
    pub fn scalar(&self) -> Option<&Value> {
        match &self.kind {
            Kind::Scalar(v) => Some(v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match &self.kind {
            Kind::Scalar(Value::Str(s)) => Some(s),
            _ => None,
        }
    }
    pub fn pairs(&self) -> &[Pair] {
        match &self.kind {
            Kind::Map(pairs) => pairs,
            _ => &[],
        }
    }
    pub fn items(&self) -> &[Node] {
        match &self.kind {
            Kind::Seq(items) => items,
            _ => &[],
        }
    }
    /// The entry for `key` in this mapping (the first, if repeated).
    pub fn pair(&self, key: &str) -> Option<&Pair> {
        self.pairs().iter().find(|p| p.key.str() == Some(key))
    }
    /// Absent, `null`, or an empty / whitespace-only string.
    pub fn is_empty_value(&self) -> bool {
        match &self.kind {
            Kind::Scalar(Value::Null) => true,
            Kind::Scalar(Value::Str(s)) => s.trim().is_empty(),
            _ => false,
        }
    }
}

/// Parse `src` into a positioned tree. Never fails: a syntax error becomes a
/// [`Problem`] and whatever was read before it is dropped.
pub fn parse(src: &str) -> Document {
    let chars: Vec<char> = src.chars().collect();
    let mut b = Builder { parser: Parser::new_from_str(src), chars: &chars, problems: Vec::new() };
    let root = match b.document() {
        Ok(root) => root,
        Err(problem) => {
            b.problems.push(problem);
            None
        }
    };
    Document { root, problems: b.problems }
}

struct Builder<'a> {
    parser: Parser<'a, saphyr_parser::StrInput<'a>>,
    chars: &'a [char],
    problems: Vec<Problem>,
}

impl Builder<'_> {
    fn next(&mut self) -> Result<(Event<'static>, Span), Problem> {
        match self.parser.next_event() {
            Some(Ok((ev, span))) => Ok((into_owned(ev), span)),
            Some(Err(e)) => Err(Problem::Syntax { at: e.marker().index(), message: e.info().to_string() }),
            None => Ok((Event::StreamEnd, Span::empty(saphyr_parser::Marker::new(self.chars.len(), 0, 0)))),
        }
    }

    fn document(&mut self) -> Result<Option<Node>, Problem> {
        let mut root = None;
        let mut docs = 0;
        loop {
            let (ev, span) = self.next()?;
            match ev {
                Event::StreamEnd => return Ok(root),
                Event::DocumentStart(_) => {
                    docs += 1;
                    if docs > 1 {
                        return Err(Problem::Syntax {
                            at: span.start.index(),
                            message: "Source contains multiple documents".into(),
                        });
                    }
                }
                Event::StreamStart | Event::DocumentEnd | Event::Nothing => {}
                ev => root = Some(self.node(ev, span)?),
            }
        }
    }

    fn node(&mut self, ev: Event<'static>, span: Span) -> Result<Node, Problem> {
        let start = span.start.index();
        Ok(match ev {
            Event::Scalar(text, style, _, tag) => {
                let tagged_str = tag.is_some_and(|t| t.suffix == "str" || t.suffix == "tag:yaml.org,2002:str");
                let value = if style == ScalarStyle::Plain && !tagged_str {
                    resolve_plain(&text)
                } else {
                    Value::Str(text.into_owned())
                };
                Node { kind: Kind::Scalar(value), range: (start, span.end.index()) }
            }
            Event::SequenceStart(..) => {
                let mut items = Vec::new();
                loop {
                    let (ev, span) = self.next()?;
                    if matches!(ev, Event::SequenceEnd) {
                        break Node { kind: Kind::Seq(items), range: (start, self.end(span)) };
                    }
                    items.push(self.node(ev, span)?);
                }
            }
            Event::MappingStart(..) => {
                let mut pairs: Vec<Pair> = Vec::new();
                loop {
                    let (ev, span) = self.next()?;
                    if matches!(ev, Event::MappingEnd) {
                        break Node { kind: Kind::Map(pairs), range: (start, self.end(span)) };
                    }
                    let key = self.node(ev, span)?;
                    let (ev, span) = self.next()?;
                    let mut value = self.node(ev, span)?;
                    self.place_empty_value(&key, &mut value);
                    if let Some(k) = key.str() {
                        if pairs.iter().any(|p| p.key.str() == Some(k)) {
                            self.problems.push(Problem::DuplicateKey { range: key.range, key: k.to_string() });
                        }
                    }
                    pairs.push(Pair { key, value });
                }
            }
            _ => Node { kind: Kind::Alias, range: (start, span.end.index()) },
        })
    }

    /// A collection's end: the parser may run it up to the next token, past
    /// trailing spaces.
    fn end(&self, span: Span) -> usize {
        let mut end = span.end.index();
        while end > 0 && self.chars.get(end - 1).is_some_and(|c| *c == ' ' || *c == '\t') {
            end -= 1;
        }
        end
    }

    /// The parser places an omitted value (`type:`) at the end of its key; put
    /// it after the `:` instead, so "this entry" spans `type:`.
    fn place_empty_value(&self, key: &Node, value: &mut Node) {
        if value.range.0 != value.range.1 || value.range.0 != key.range.1 {
            return;
        }
        let mut i = key.range.1;
        while self.chars.get(i).is_some_and(|c| *c == ' ' || *c == '\t') {
            i += 1;
        }
        if self.chars.get(i) == Some(&':') {
            value.range = (i + 1, i + 1);
        }
    }
}

fn into_owned(ev: Event<'_>) -> Event<'static> {
    use std::borrow::Cow;
    match ev {
        Event::Scalar(s, style, anchor, tag) => Event::Scalar(
            Cow::Owned(s.into_owned()),
            style,
            anchor,
            tag.map(|t| Cow::Owned(t.into_owned())),
        ),
        Event::SequenceStart(a, tag) => Event::SequenceStart(a, tag.map(|t| Cow::Owned(t.into_owned()))),
        Event::MappingStart(a, tag) => Event::MappingStart(a, tag.map(|t| Cow::Owned(t.into_owned()))),
        Event::Nothing => Event::Nothing,
        Event::StreamStart => Event::StreamStart,
        Event::StreamEnd => Event::StreamEnd,
        Event::DocumentStart(e) => Event::DocumentStart(e),
        Event::DocumentEnd => Event::DocumentEnd,
        Event::Alias(a) => Event::Alias(a),
        Event::SequenceEnd => Event::SequenceEnd,
        Event::MappingEnd => Event::MappingEnd,
    }
}

/// A plain scalar by the YAML 1.2 core schema (null, bool, int, float, else
/// string).
fn resolve_plain(s: &str) -> Value {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        ".nan" | ".NaN" | ".NAN" => return Value::Number(f64::NAN),
        _ => {}
    }
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    let negative = s.starts_with('-');
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return Value::Number(if negative { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    if let Some(oct) = s.strip_prefix("0o") {
        if let Ok(n) = i64::from_str_radix(oct, 8) {
            return Value::Number(n as f64);
        }
    }
    if let Some(hex) = s.strip_prefix("0x") {
        if let Ok(n) = i64::from_str_radix(hex, 16) {
            return Value::Number(n as f64);
        }
    }
    if is_core_float(unsigned) {
        if let Ok(n) = s.parse::<f64>() {
            return Value::Number(n);
        }
    }
    Value::Str(s.to_string())
}

/// `(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`, the core schema's
/// int/float shape without the sign.
fn is_core_float(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |i: &mut usize| {
        let start = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i - start
    };
    let mut i = 0;
    if b.first() == Some(&b'.') {
        i = 1;
        if digits(&mut i) == 0 {
            return false;
        }
    } else {
        if digits(&mut i) == 0 {
            return false;
        }
        if b.get(i) == Some(&b'.') {
            i += 1;
            digits(&mut i);
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_scalars_resolve_by_the_core_schema() {
        assert_eq!(resolve_plain("1984"), Value::Number(1984.0));
        assert_eq!(resolve_plain("-1"), Value::Number(-1.0));
        assert_eq!(resolve_plain("2.5"), Value::Number(2.5));
        assert_eq!(resolve_plain("1e3"), Value::Number(1000.0));
        assert_eq!(resolve_plain("~"), Value::Null);
        assert_eq!(resolve_plain("True"), Value::Bool(true));
        assert_eq!(resolve_plain("yes"), Value::Str("yes".into()));
        assert_eq!(resolve_plain("2026-06-30"), Value::Str("2026-06-30".into()));
        assert_eq!(resolve_plain("1."), Value::Number(1.0));
        assert_eq!(resolve_plain("1.2.3"), Value::Str("1.2.3".into()));
    }

    #[test]
    fn quoted_scalars_stay_strings() {
        let doc = parse("a: '1'\nb: \"true\"\nc: !!str 3\n");
        let root = doc.root.unwrap();
        for k in ["a", "b", "c"] {
            assert!(root.pair(k).unwrap().value.str().is_some(), "{k}");
        }
    }

    #[test]
    fn duplicate_keys_are_reported_at_the_repeat() {
        let doc = parse("type: a\ntype: b\n");
        assert_eq!(doc.problems, vec![Problem::DuplicateKey { range: (8, 12), key: "type".into() }]);
        assert!(!doc.malformed());
    }

    #[test]
    fn an_omitted_value_sits_after_the_colon() {
        let doc = parse("type:\n");
        assert_eq!(doc.root.unwrap().pair("type").unwrap().value.range, (5, 5));
    }

    #[test]
    fn syntax_errors_and_multiple_documents_are_malformed() {
        assert!(parse("tags: [a, b\n").malformed());
        assert!(parse("a: 1\n---\nb: 2\n").malformed());
        assert!(parse("").root.is_none());
        assert!(parse("# only a comment\n").root.is_none());
    }
}
