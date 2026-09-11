"""
Minimal S-expression reader/writer for KiCad files (.kicad_mod, .kicad_pcb).

A node is either a list (child nodes) or an atom. Atoms keep their original
text so quoted strings round-trip exactly: a quoted atom is stored as a
QStr, a bare atom as a plain str.
"""


class QStr(str):
    """A string that was quoted in the source and must be quoted on output."""


def parse(text):
    """Parse the first S-expression in text and return it as nested lists."""
    tokens = _tokenize(text)
    node, _ = _read(tokens, 0)
    return node


def _tokenize(text):
    out = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in ' \t\r\n':
            i += 1
        elif ch == '(' or ch == ')':
            out.append(ch)
            i += 1
        elif ch == '"':
            j = i + 1
            buf = []
            while j < n and text[j] != '"':
                if text[j] == '\\' and j + 1 < n:
                    buf.append(text[j + 1])
                    j += 2
                    continue
                buf.append(text[j])
                j += 1
            out.append(QStr(''.join(buf)))
            i = j + 1
        else:
            j = i
            while j < n and text[j] not in ' \t\r\n()"':
                j += 1
            out.append(text[i:j])
            i = j
    return out


def _read(tokens, i):
    tok = tokens[i]
    if tok == '(':
        lst = []
        i += 1
        while tokens[i] != ')':
            node, i = _read(tokens, i)
            lst.append(node)
        return lst, i + 1
    return tok, i + 1


def dumps(node, indent=0):
    """Serialize nested lists back to KiCad-style text (one child list per line)."""
    if not isinstance(node, list):
        return _atom(node)
    pad = '  ' * indent
    # Leading atoms stay on the head line; from the first child list on,
    # everything (lists and any later atoms) goes on its own line, in order.
    atoms = []
    children = []
    for child in node:
        if children or isinstance(child, list):
            children.append(child)
        else:
            atoms.append(child)
    head = pad + '(' + ' '.join(_atom(a) for a in atoms)
    if not children:
        return head + ')'
    lines = [head]
    for c in children:
        lines.append(dumps(c, indent + 1) if isinstance(c, list) else '  ' * (indent + 1) + _atom(c))
    return '\n'.join(lines) + '\n' + pad + ')'


def _atom(a):
    if isinstance(a, QStr):
        return '"' + a.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return str(a)


# ── tree helpers ──────────────────────────────────────────────────

def find(node, key):
    """First child list whose head is key, or None."""
    for c in node:
        if isinstance(c, list) and c and c[0] == key:
            return c
    return None


def find_all(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]


def set_child(node, key, new_child):
    """Replace the first child list headed by key, or append it."""
    for i, c in enumerate(node):
        if isinstance(c, list) and c and c[0] == key:
            node[i] = new_child
            return
    node.append(new_child)
