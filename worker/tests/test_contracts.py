import copy
import json
from pathlib import Path
import unittest

from recdock_audio.contracts import validate, AudioContractError


class SharedContractTests(unittest.TestCase):
    def test_shared_corpus(self):
        path = Path(__file__).resolve().parents[2] / "contracts/fixtures/contract-cases.json"
        fixtures = json.loads(path.read_text(encoding="utf-8"))
        for case in fixtures["cases"]:
            with self.subTest(case=case["id"]):
                base = fixtures["bases"][case["base"]]
                data = copy.deepcopy(base["data"])
                for patch in case["patches"]:
                    target = data
                    for key in patch["path"][:-1]:
                        target = target[key]
                    target[patch["path"][-1]] = patch["value"]
                if case["valid"]:
                    validate(base["kind"], data)
                else:
                    with self.assertRaises(AudioContractError):
                        validate(base["kind"], data)


if __name__ == "__main__":
    unittest.main()
