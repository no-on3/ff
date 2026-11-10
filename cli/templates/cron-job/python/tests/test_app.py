# The job's report, outside its CodeUri so that no package holds it: python3 -m unittest, from the application's
# folder. The bucket is a stand-in that lists the files it is given, and keeps what the job writes.
import json
import pathlib
import unittest
from datetime import datetime, timedelta, timezone

from src import app

EVENTS = pathlib.Path(__file__).parents[1] / "events"


def scheduled():
    return json.loads((EVENTS / "scheduled.json").read_text())


def file(key, size, last_modified):
    return {"key": key, "size": size, "lastModified": last_modified}


class StandIn:
    def __init__(self, *files):
        self.files = list(files)
        self.listed = []
        self.written = {}

    def list(self, prefix):
        self.listed.append(prefix)
        return [one for one in self.files if one["key"].startswith(prefix)]

    def put(self, key, body):
        self.written[key] = json.loads(body)


class ReportTest(unittest.TestCase):
    def test_the_schedules_run_reports_the_day_before_its_time_the_files_that_arrived_under_incoming_that_day(self):
        bucket = StandIn(
            file("incoming/late.csv", 300, "2026-11-08T23:59:59.000Z"),
            file("incoming/orders.csv", 1200, "2026-11-09T08:15:00.000Z"),
            file("incoming/photo.jpg", 5000, "2026-11-09T17:40:00.000Z"),
            file("incoming/early.csv", 70, "2026-11-10T00:00:01.000Z"),
            file("reports/2026-11-08.json", 90, "2026-11-09T06:00:02.000Z"),
        )

        summary = app.report(scheduled(), bucket)

        largest = {"key": "incoming/photo.jpg", "size": 5000}
        expected = {"day": "2026-11-09", "files": 2, "bytes": 6200, "largest": largest}
        self.assertEqual(summary, expected)
        self.assertEqual(bucket.written, {"reports/2026-11-09.json": expected})
        self.assertEqual(bucket.listed, ["incoming/"])

    def test_a_day_without_files_is_reported_too_as_none(self):
        bucket = StandIn()

        app.report(scheduled(), bucket)

        self.assertEqual(
            bucket.written["reports/2026-11-09.json"], {"day": "2026-11-09", "files": 0, "bytes": 0, "largest": None}
        )

    def test_the_day_is_utcs_a_run_at_00_30_in_tunis_is_the_day_befores_in_utc(self):
        summary = app.report({**scheduled(), "time": "2026-11-10T00:30:00+01:00"}, StandIn())

        self.assertEqual(summary["day"], "2026-11-08")

    def test_a_run_by_hand_reports_the_day_it_names(self):
        bucket = StandIn(file("incoming/today.txt", 12, "2026-11-10T09:00:00.000Z"))

        app.report({"day": "2026-11-10"}, bucket)

        self.assertEqual(bucket.written["reports/2026-11-10.json"]["files"], 1)

    def test_without_a_time_it_reports_yesterday(self):
        summary = app.report({}, StandIn())

        self.assertEqual(summary["day"], (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat())

    def test_an_event_whose_time_or_day_is_no_date_fails_the_run_nothing_written_so_that_it_is_tried_again(self):
        for event in [{"time": "yesterday"}, {"day": "2026-13-01"}, {"day": "9 November"}, {"day": 20261109}]:
            with self.subTest(event=event):
                bucket = StandIn()

                with self.assertRaisesRegex(ValueError, "time is no date|YYYY-MM-DD"):
                    app.report(event, bucket)
                self.assertEqual((bucket.listed, bucket.written), ([], {}))


if __name__ == "__main__":
    unittest.main()
