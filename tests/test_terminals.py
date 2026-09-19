import unittest
import main


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.previous = main.players.copy()
        main.players.clear()
        self.terminal = main.TERMINALS[0]
        for name in ('a', 'b'):
            main.players[name] = {'id': name, 'x': self.terminal['x'],
                'y': self.terminal['y'] + 32, 'terminal_id': None,
                'state': 'idle', 'input': {}, 'feedback': '', 'solved': set()}

    def tearDown(self):
        main.players.clear()
        main.players.update(self.previous)

    def test_exclusive_claim_and_release(self):
        a, b = main.players.values()
        main.handle_action(a, {'type': 'interact'})
        main.handle_action(b, {'type': 'interact'})
        self.assertEqual(main.terminal_owner(self.terminal['id']), 'a')
        self.assertIsNone(b['terminal_id'])
        self.assertIn('in use', b['feedback'])
        main.handle_action(a, {'type': 'leave_terminal'})
        main.handle_action(b, {'type': 'interact'})
        self.assertEqual(main.terminal_owner(self.terminal['id']), 'b')
        del main.players['b']
        self.assertIsNone(main.terminal_owner(self.terminal['id']))

    def test_remote_claim_and_unseated_answer_rejected(self):
        a = main.players['a']
        a['x'], a['y'] = main.SPAWNS[0]
        main.handle_action(a, {'type': 'interact', 'terminal_id': self.terminal['id']})
        main.handle_action(a, {'type': 'submit_answer', 'answer': '4'})
        self.assertIsNone(a['terminal_id'])
        self.assertFalse(a['solved'])

    def test_feedback_and_completion_are_personal_and_idempotent(self):
        a, b = main.players.values()
        main.handle_action(a, {'type': 'interact'})
        main.handle_action(a, {'type': 'submit_answer', 'answer': '3'})
        self.assertIn('Try again', a['feedback'])
        main.handle_action(a, {'type': 'submit_answer', 'answer': {'bad': 'data'}})
        self.assertIn('integer', a['feedback'])
        main.handle_action(a, {'type': 'submit_answer', 'answer': '4'})
        main.handle_action(a, {'type': 'submit_answer', 'answer': '4'})
        self.assertEqual(len(a['solved']), 1)
        self.assertEqual(len(b['solved']), 0)
        self.assertNotIn('answer', main.private_state(a)['puzzle'])
        main.release_terminal(a)
        main.handle_action(a, {'type': 'interact'})
        self.assertTrue(main.private_state(a)['solved'])

    def test_all_seats_are_walkable(self):
        self.assertEqual(len(main.TERMINALS), 8)
        for terminal in main.TERMINALS:
            self.assertTrue(main.can_stand(terminal['x'], terminal['y'] + 32))

    def test_checklist_tracks_only_own_solved_computers_after_leaving(self):
        a, b = main.players.values()
        main.handle_action(a, {'type': 'interact'})
        main.handle_action(a, {'type': 'submit_answer', 'answer': '3'})
        self.assertEqual(main.private_state(a)['completed_terminals'], [])
        main.handle_action(a, {'type': 'submit_answer', 'answer': '4'})
        main.release_terminal(a)
        state = main.private_state(a)
        self.assertEqual(state['completed_terminals'], [self.terminal['id']])
        self.assertEqual(state['completed'], 1)
        self.assertIsNone(state['puzzle'])
        self.assertEqual(main.private_state(b)['completed_terminals'], [])
        state['completed_terminals'].clear()
        self.assertEqual(main.private_state(a)['completed'], 1)
