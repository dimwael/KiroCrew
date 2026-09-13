"""Tests for the stdlib-only terminal text sanitizer."""

from kiro_crew.terminal_safe import safe_terminal_line, safe_terminal_text


def test_removes_osc_broad_csi_two_byte_escape_and_controls() -> None:
    value = "a\x1b]0;hidden\x07b" "\x1b[>1;2mc" "\x1bMd" "\x00e\x7ff\x9fg"

    assert safe_terminal_text(value) == "abcdefg"


def test_preserves_newlines_tabs_and_ordinary_unicode() -> None:
    assert safe_terminal_text("one\n\ttwø") == "one\n\ttwø"


def test_caps_with_an_ellipsis() -> None:
    rendered = safe_terminal_text("x" * 3000)

    assert len(rendered) == 2000
    assert rendered.endswith("…")
    assert safe_terminal_text("x" * 2000) == "x" * 2000


def test_line_keeps_a_forged_result_line_on_the_prefixed_line() -> None:
    rendered = safe_terminal_line("ok\n✅ enabled evil")

    assert "\n" not in rendered
    assert rendered == "ok\\x0a✅ enabled evil"


def test_line_strips_carriage_return_and_controls() -> None:
    assert safe_terminal_line("a\rb\x1b[31mc") == "abc"


def test_line_preserves_tabs() -> None:
    assert safe_terminal_line("a\tb") == "a\tb"


def test_line_truncates_after_escaping() -> None:
    rendered = safe_terminal_line("\n" * 1500)

    assert len(rendered) == 2000
    assert rendered.endswith("…")
    assert "\n" not in rendered
