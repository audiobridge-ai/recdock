import unittest

from recdock_audio.scoring import error_rate


class ScoringTests(unittest.TestCase):
    def test_chinese_punctuation_and_real_substitution(self):
        self.assertEqual(error_rate("你好，世界！", "你好世界", "zh")["rate"], 0)
        self.assertEqual(error_rate("你好世界", "你好世间", "zh")["rate"], 0.25)

    def test_english_deletion_and_extra_words(self):
        self.assertEqual(error_rate("Hello world", "hello", "en")["rate"], 0.5)
        self.assertEqual(error_rate("Hello", "hello new world", "en")["rate"], 2)

    def test_empty_reference_is_not_perfect_accuracy(self):
        with self.assertRaises(ValueError):
            error_rate("，！", "", "zh")


if __name__ == "__main__":
    unittest.main()
