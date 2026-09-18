import unittest
import main


class LilyTests(unittest.TestCase):
    def setUp(self):
        self.saved = main.players.copy()
        main.players.clear()
        for name in ('a', 'b'):
            main.players[name] = {'id': name, 'name': name, 'x': 144., 'y': 496.,
                'state': 'idle', 'lily_id': None, 'feedback': ''}
        self.a, self.b = main.players.values()

    def tearDown(self):
        main.players.clear()
        main.players.update(self.saved)

    def test_exclusive_pickup_transfer_and_disconnect(self):
        main.handle_action(self.a, {'type': 'pick_lily'})
        main.handle_action(self.b, {'type': 'pick_lily'})
        self.assertEqual(self.a['lily_id'], 'lily-1')
        self.assertIsNone(self.b['lily_id'])
        main.handle_action(self.a, {'type': 'give_lily'})
        self.assertIsNone(self.a['lily_id'])
        self.assertEqual(self.b['lily_id'], 'lily-1')
        main.handle_action(self.a, {'type': 'give_lily'})
        self.assertEqual(main.lily_holder('lily-1'), 'b')
        main.remove_player('b')
        self.assertIsNone(main.lily_holder('lily-1'))

    def test_no_swapping_held_flower_or_overwriting_recipient(self):
        self.a['lily_id'] = 'lily-2'
        self.b['lily_id'] = 'lily-3'
        main.handle_action(self.a, {'type': 'pick_lily'})
        self.assertEqual(self.a['lily_id'], 'lily-2')
        main.handle_action(self.a, {'type': 'give_lily'})
        self.assertEqual(self.a['lily_id'], 'lily-2')
        self.assertEqual(self.b['lily_id'], 'lily-3')

    def test_range_walls_and_seated_pickup(self):
        self.a.update(x=400., y=368.)
        main.handle_action(self.a, {'type': 'pick_lily', 'lily_id': 'lily-1'})
        self.assertIsNone(self.a['lily_id'])
        self.a.update(x=336., y=176., lily_id='lily-1')
        self.b.update(x=380., y=176.)
        main.handle_action(self.a, {'type': 'give_lily'})
        self.assertEqual(self.a['lily_id'], 'lily-1')
        self.a.update(x=144., y=496., lily_id=None, state='seated')
        main.handle_action(self.a, {'type': 'pick_lily'})
        self.assertIsNone(self.a['lily_id'])
