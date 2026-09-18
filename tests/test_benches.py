import unittest
import main


class BenchTests(unittest.TestCase):
    def setUp(self):
        self.saved = main.players.copy()
        main.players.clear()
        self.bench = main.BENCHES[0]
        for name in ('a', 'b'):
            main.players[name] = {'id': name, 'state': 'idle', 'role': 'student',
                'x': self.bench['x'], 'y': self.bench['y'] + 32,
                'desk_id': None, 'bench_id': None, 'terminal_id': None,
                'input': {}, 'feedback': '', 'solved': set()}
        self.a, self.b = main.players.values()

    def tearDown(self):
        main.players.clear()
        main.players.update(self.saved)

    def test_occupancy_and_both_exit_actions(self):
        for p in (self.a, self.b):
            main.handle_action(p, {'type': 'interact'})
        self.assertEqual(self.a['bench_id'], self.bench['id'])
        self.assertIsNone(self.b['bench_id'])
        self.assertEqual(self.a['y'], self.bench['y'])
        for action in ('interact', 'leave_activity', 'leave_terminal'):
            main.handle_action(self.a, {'type': action})
            self.assertIsNone(self.a['bench_id'])
            self.assertTrue(main.can_stand(self.a['x'], self.a['y']))
            main.handle_action(self.a, {'type': 'interact'})
        main.remove_player('a')
        main.handle_action(self.b, {'type': 'interact'})
        self.assertEqual(self.b['bench_id'], self.bench['id'])

    def test_four_safe_seats_and_adjacent_seats_are_independent(self):
        self.assertEqual(len(main.BENCHES), 4)
        for bench in main.BENCHES:
            self.assertTrue(main.can_stand(bench['x'], bench['y'] + 32))
        main.handle_action(self.a, {'type': 'interact'})
        other = main.BENCHES[1]
        self.b.update(x=other['x'], y=other['y'] + 32)
        main.handle_action(self.b, {'type': 'interact'})
        self.assertEqual(self.b['bench_id'], other['id'])
        self.assertNotEqual(self.a['bench_id'], self.b['bench_id'])

    def test_remote_claim_rejected(self):
        self.a.update(x=400., y=368.)
        main.handle_action(self.a, {'type': 'interact', 'bench_id': self.bench['id']})
        self.assertIsNone(self.a['bench_id'])
