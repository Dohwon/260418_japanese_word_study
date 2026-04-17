import html
import json
import math
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import fitz
from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "DATA"
CACHE_PATH = DATA_DIR / "ocr_dictionary_cache.json"
DAY_COUNT = 28

PDF_BY_LEVEL = {
    "N3": DATA_DIR / "(3rd EDITION) JLPT 한권으로 끝내기 보카 N3_쪽지 시험 2.pdf",
    "N2": DATA_DIR / "(3rd EDITION) JLPT 한권으로 끝내기 보카 N2_쪽지 시험 2.pdf",
    "N1": DATA_DIR / "(3rd EDITION) JLPT 한권으로 끝내기 보카 N1_쪽지 시험 2.pdf",
}

COMMON_FIXES = {
    "空っぼほ": "空っぽ",
    "空っぼ": "空っぽ",
    "空うぼ": "空っぽ",
}


@dataclass
class Entry:
    id: int
    kanji: str
    hiragana: str
    meaning: str
    day: int
    level: str
    page: int


def load_cache():
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


def save_cache(cache):
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2))


def page_image(page):
    pix = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
    return Image.frombytes("RGB", [pix.width, pix.height], pix.samples)


def crop_word_column(image):
    width, height = image.size
    crop = image.convert("L").crop(
        (
            int(width * 0.025),
            int(height * 0.10),
            int(width * 0.29),
            int(height * 0.95),
        )
    )
    crop = ImageOps.autocontrast(crop)
    crop = crop.point(lambda value: 255 if value > 210 else 0)
    return crop


def run_tesseract(image_path):
    result = subprocess.run(
        [
            "tesseract",
            str(image_path),
            "stdout",
            "-l",
            "jpn",
            "--psm",
            "11",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout


def http_get(url):
    result = subprocess.run(
        ["curl", "-L", "-sS", url],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"curl failed for {url}")
    return result.stdout


def normalize_word(token):
    cleaned = token.strip()
    cleaned = cleaned.replace(" ", "")
    cleaned = cleaned.replace("・", "·")
    cleaned = cleaned.replace("〜", "~")
    cleaned = re.sub(r"^[\[\]【】\-\—\‐\·\.。,:;、]+", "", cleaned)
    cleaned = re.sub(r"[\[\]【】\-\—\‐\·\.。,:;、]+$", "", cleaned)
    cleaned = COMMON_FIXES.get(cleaned, cleaned)
    return cleaned


def looks_like_word(token):
    if len(token) < 1:
        return False
    if re.fullmatch(r"[0-9]+", token):
        return False
    if re.search(r"[A-Za-z]", token):
        return False
    if "日째" in token or "일째" in token:
        return False
    if any(fragment in token for fragment in ["읽기", "의미", "예", "접두어", "접미어"]):
        return False
    if re.fullmatch(r"[ー~]+", token):
        return False
    if len(token) == 1 and token in {"L", "了", "田", "感", "迎"}:
        return False
    return True


def extract_words_from_page(page, level, page_number):
    image = page_image(page)
    crop = crop_word_column(image)
    temp_path = Path("/tmp") / f"{level.lower()}_{page_number}_words.png"
    crop.save(temp_path)
    raw_text = run_tesseract(temp_path)

    candidates = []
    for line in raw_text.splitlines():
        normalized = normalize_word(line)
        if looks_like_word(normalized):
            candidates.append(normalized)

    deduped = []
    for candidate in candidates:
        if not deduped or deduped[-1] != candidate:
            deduped.append(candidate)

    return deduped


def extract_words(level):
    cache_path = DATA_DIR / f"{level.lower()}_ocr_pages.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text())

    path = PDF_BY_LEVEL[level]
    doc = fitz.open(path)
    extracted = []
    for page_index in range(doc.page_count):
        words = extract_words_from_page(doc.load_page(page_index), level, page_index + 1)
        if len(words) >= 4:
            extracted.append(
                {
                    "page": page_index + 1,
                    "words": words,
                }
            )

    cache_path.write_text(json.dumps(extracted, ensure_ascii=False, indent=2))
    return extracted


def strip_tags(fragment):
    text = re.sub(r"<[^>]+>", " ", fragment)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def compress_english_gloss(gloss):
    parts = re.split(r"[;,/]", gloss)
    compact = []
    seen = set()
    for part in parts:
        item = re.sub(r"\s+", " ", part).strip(" ()")
        if not item:
            continue
        lowered = item.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        compact.append(item)
        if len(compact) == 3:
            break
    return ", ".join(compact) if compact else gloss


def parse_cjkv(word):
    url = f"https://cjkvdict.com/?search={quote(word)}"
    document = http_get(url)

    japanese_match = re.search(
        r"<div class=\"column-section\">\s*<h2>Japanese.*?</h2>(.*?)</div>",
        document,
        flags=re.S,
    )
    if not japanese_match:
        return None

    japanese_block = japanese_match.group(1)
    kana_match = re.search(r"<tr><td>Kana:</td><td[^>]*>(.*?)</td></tr>", japanese_block, flags=re.S)
    definition_match = re.search(r"<tr><td>Definition:</td><td>(.*?)</td></tr>", japanese_block, flags=re.S)
    headword_match = re.search(r"<h1[^>]*>.*?<a[^>]*>(.*?)</a></h1>", japanese_block, flags=re.S)

    kana = strip_tags(kana_match.group(1)) if kana_match else ""
    english_definition = strip_tags(definition_match.group(1)) if definition_match else ""
    headword = strip_tags(headword_match.group(1)).strip() if headword_match else word

    if not kana and not english_definition:
        return None

    return {
        "headword": headword,
        "hiragana": kana or word,
        "english_definition": english_definition or word,
    }


def translate_to_korean(english_text):
    query = quote(english_text)
    url = (
        "https://translate.googleapis.com/translate_a/single"
        f"?client=gtx&sl=en&tl=ko&dt=t&q={query}"
    )
    payload = json.loads(http_get(url))
    chunks = payload[0] if payload and payload[0] else []
    translated = "".join(part[0] for part in chunks if part and part[0])
    translated = translated.replace(" ; ", ", ").replace(";", ", ")
    translated = translated.replace(" , ", ", ")
    return translated.strip()


def enrich_word(level, word, cache):
    cache_key = f"word:{word}"
    if cache_key in cache:
        return cache[cache_key]

    data = parse_cjkv(word)
    if not data:
        payload = {
            "kanji": word,
            "hiragana": word,
            "meaning": word,
            "status": "unresolved",
        }
        cache[cache_key] = payload
        return payload

    compressed_gloss = compress_english_gloss(data["english_definition"])
    translation_key = f"translation:{compressed_gloss}"
    korean_meaning = cache.get(translation_key)
    if not korean_meaning:
        korean_meaning = translate_to_korean(compressed_gloss)
        cache[translation_key] = korean_meaning

    payload = {
        "kanji": word,
        "hiragana": data["hiragana"] or word,
        "meaning": korean_meaning or compressed_gloss,
        "status": "resolved",
    }
    cache[cache_key] = payload
    return payload


def assign_days(pages):
    flattened = []
    for page in pages:
        for word in page["words"]:
            flattened.append({"page": page["page"], "word": word})

    if not flattened:
        return []

    page_numbers = [item["page"] for item in flattened]
    min_page = min(page_numbers)
    max_page = max(page_numbers)
    span = max(1, max_page - min_page + 1)

    results = []
    for item in flattened:
        relative = (item["page"] - min_page) / span
        day = min(DAY_COUNT, max(1, math.floor(relative * DAY_COUNT) + 1))
        results.append({**item, "day": day})
    return results


def build_level(level, batch_size=None):
    cache = load_cache()
    pages = extract_words(level)
    assigned = assign_days(pages)
    unique_words = list(dict.fromkeys(item["word"] for item in assigned))
    resolved_map = {}
    pending_words = [word for word in unique_words if f"word:{word}" not in cache]

    if batch_size:
        pending_words = pending_words[:batch_size]

    def resolve(word):
        try:
            return word, enrich_word(level, word, cache)
        except Exception:
            payload = {
                "kanji": word,
                "hiragana": word,
                "meaning": word,
                "status": "unresolved",
            }
            cache[f"word:{word}"] = payload
            return word, payload

    if pending_words:
        with ThreadPoolExecutor(max_workers=16) as executor:
            futures = [executor.submit(resolve, word) for word in pending_words]
            for index, future in enumerate(as_completed(futures), start=1):
                word, enriched = future.result()
                resolved_map[word] = enriched
                if index % 20 == 0:
                    save_cache(cache)
                    print(
                        f"{level}: processed {index}/{len(pending_words)} pending words",
                        flush=True,
                    )
    else:
        print(f"{level}: no pending words, building output from cache", flush=True)

    for word in unique_words:
        cache_key = f"word:{word}"
        if cache_key in cache:
            resolved_map[word] = cache[cache_key]

    entries = []
    unresolved = []
    for index, item in enumerate(assigned, start=1):
        enriched = resolved_map.get(item["word"]) or {
            "kanji": item["word"],
            "hiragana": item["word"],
            "meaning": item["word"],
            "status": "unresolved",
        }
        entries.append(
            Entry(
                id=index,
                kanji=enriched["kanji"],
                hiragana=enriched["hiragana"],
                meaning=enriched["meaning"],
                day=item["day"],
                level=level,
                page=item["page"],
            )
        )
        if enriched["status"] != "resolved":
            unresolved.append(item["word"])

    save_cache(cache)
    return entries, unresolved, len(pending_words), len(unique_words)


def write_outputs(level, entries):
    json_path = DATA_DIR / f"{level.lower()}_vocab_ocr.json"
    payload = [
        {
            "id": entry.id,
            "kanji": entry.kanji,
            "hiragana": entry.hiragana,
            "meaning": entry.meaning,
            "day": entry.day,
            "level": entry.level,
            "page": entry.page,
        }
        for entry in entries
    ]
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    return json_path


def main():
    levels = []
    batch_size = None
    args = sys.argv[1:] or ["N3", "N2", "N1"]

    index = 0
    while index < len(args):
        if args[index] == "--batch-size":
            batch_size = int(args[index + 1])
            index += 2
            continue
        levels.append(args[index])
        index += 1

    for level in levels:
        entries, unresolved, processed_now, total_unique = build_level(level, batch_size=batch_size)
        output_path = write_outputs(level, entries)
        print(
            f"{level}: pending batch processed {processed_now}, cached total {total_unique - len(unresolved)} / {total_unique}",
            flush=True,
        )
        print(f"{level}: wrote {len(entries)} entries -> {output_path}", flush=True)
        if unresolved:
            print(f"{level}: unresolved sample -> {unresolved[:20]}", flush=True)


if __name__ == "__main__":
    main()
