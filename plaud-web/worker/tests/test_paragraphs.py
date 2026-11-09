import copy
import json
import unittest

from recdock_audio.paragraphs import chunk_paragraphs, merge_recording, word_spans
from recdock_audio.long_review import render_html


class ParagraphTests(unittest.TestCase):
    def test_preserves_punctuation_spaces_and_contractions(self):
        text = "  Hello, let's go!  再见。 "
        tokens = ["Hello", "let's", "go", "再", "见"]
        words = [{"text": t, "startMs": i * 1000, "endMs": (i + 1) * 1000} for i, t in enumerate(tokens)]
        mapped = word_spans(text, words)
        self.assertEqual("".join(text[w["charStart"]:w["charEnd"]] for w in mapped), text)

    def test_mismatch_does_not_guess_token_positions(self):
        with self.assertRaisesRegex(ValueError, "MAPPING_MISMATCH"):
            word_spans("hello world", [{"text": "hallucination"}])

    def test_zero_only_sentence_joins_neighbour_without_word_interpolation(self):
        chunk = {"id": "c", "startMs": 0, "endMs": 10000, "text": "Yes. Hello world."}
        words = [{"text": "Yes", "startMs": 200, "endMs": 200}, {"text": "Hello", "startMs": 400, "endMs": 1000}, {"text": "world", "startMs": 1000, "endMs": 2000}]
        turns = [{"startMs": 0, "endMs": 3000, "speakerId": "a"}]
        original = copy.deepcopy(words)
        result = chunk_paragraphs(chunk, {**chunk, "words": words}, turns, turns, "en")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["startMs"], 200)
        self.assertEqual(result[0]["endMs"], 2000)
        self.assertEqual(result[0]["invalidWordCount"], 1)
        self.assertEqual(words, original)

    def test_entire_unaligned_chunk_is_explicitly_coarse_and_unknown(self):
        chunk = {"id": "c", "startMs": 0, "endMs": 10000, "text": "Yes."}
        result = chunk_paragraphs(chunk, {**chunk, "words": [{"text": "Yes", "startMs": 200, "endMs": 200}]}, [], [], "en")
        self.assertEqual(result[0]["timing"], "source_chunk_only")
        self.assertIsNone(result[0]["speakerId"])
        self.assertEqual((result[0]["startMs"], result[0]["endMs"]), (0, 10000))

    def test_stable_speaker_change_splits_and_preserves_exact_text(self):
        chunk = {"id": "c", "startMs": 0, "endMs": 5000, "text": "hello there, goodbye now."}
        words = [{"text": t, "startMs": i * 1000, "endMs": i * 1000 + 900} for i, t in enumerate(["hello", "there", "goodbye", "now"])]
        turns = [{"startMs": 0, "endMs": 2000, "speakerId": "a"}, {"startMs": 2000, "endMs": 4000, "speakerId": "b"}]
        result = chunk_paragraphs(chunk, {**chunk, "words": words}, turns, turns, "en")
        self.assertEqual([p["speakerId"] for p in result], ["a", "b"])
        self.assertEqual("".join(p["text"] for p in result), chunk["text"])

    def test_overlap_is_flagged_independently_of_exclusive_assignment(self):
        chunk = {"id": "c", "startMs": 0, "endMs": 5000, "text": "hello."}
        exclusive = [{"startMs": 0, "endMs": 4000, "speakerId": "a"}]
        raw = exclusive + [{"startMs": 100, "endMs": 1000, "speakerId": "b"}]
        result = chunk_paragraphs(chunk, {**chunk, "words": [{"text": "hello", "startMs": 0, "endMs": 2000}]}, exclusive, raw, "en")
        self.assertIn("overlapping_speech", result[0]["issues"])
        self.assertEqual(result[0]["speakerId"], "a")

    def test_chinese_speaker_change_does_not_split_a_word_mid_sentence(self):
        chunk = {"id": "c", "startMs": 0, "endMs": 5000, "text": "我们开始。"}
        words = [{"text": t, "startMs": i * 1000, "endMs": i * 1000 + 900} for i, t in enumerate("我们开始")]
        turns = [{"startMs": 0, "endMs": 3000, "speakerId": "a"}, {"startMs": 3000, "endMs": 4000, "speakerId": "b"}]
        result = chunk_paragraphs(chunk, {**chunk, "words": words}, turns, turns, "zh")
        self.assertEqual([p["text"] for p in result], ["我们开始。"])
        self.assertIn("multiple_speakers_in_paragraph", result[0]["issues"])

    def test_refuses_wrong_source_and_source_offsets(self):
        chunk = {"id": "c", "startMs": 0, "endMs": 5000, "startFrame": 0, "frameCount": 80000, "text": "hello."}
        prepared = {"sourceSha256": "source", "durationMs": 5000, "chunks": [chunk]}
        asr = {"sourceSha256": "wrong", "durationMs": 5000, "status": "completed", "chunks": [chunk]}
        with self.assertRaisesRegex(ValueError, "SAME_SOURCE"):
            merge_recording(prepared, asr, asr, asr, sample_id="x", title="x", language="en", artifact_hashes={})
        asr["sourceSha256"] = "source"
        aligned = copy.deepcopy(asr)
        aligned["chunks"][0]["startMs"] = 100
        with self.assertRaisesRegex(ValueError, "TIMELINE_MISMATCH"):
            merge_recording(prepared, asr, aligned, asr, sample_id="x", title="x", language="en", artifact_hashes={})

    def test_html_keeps_transcript_as_data_even_with_script_tags(self):
        data = [{"title": '</script><script>alert("bad")</script>', "paragraphs": []}]
        rendered = render_html(data)
        payload = rendered.split('<script id="recording-data" type="application/json">', 1)[1].split('</script>', 1)[0]
        self.assertNotIn('<script', payload)
        self.assertEqual(json.loads(payload), data)
