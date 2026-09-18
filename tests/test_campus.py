"""Run with: python -m unittest discover -s tests -v"""
from collections import deque
import unittest

import main


class CampusTests(unittest.TestCase):
    def test_map_dimensions_and_spawns(self):
        self.assertEqual(len(main.CAMPUS) * main.TILE_SIZE, main.HEIGHT)
        self.assertTrue(all(len(row) * main.TILE_SIZE == main.WIDTH for row in main.CAMPUS))
        self.assertEqual(len(set(main.SPAWNS)), main.MAX_PLAYERS)
        self.assertTrue(all(main.can_stand(x, y) for x, y in main.SPAWNS))

    def test_every_walkable_tile_is_reachable(self):
        walkable = {(col, row) for row, line in enumerate(main.CAMPUS)
                    for col, tile in enumerate(line) if tile not in main.SOLID_TILES}
        start = (4, 11)
        visited = {start}
        queue = deque([start])
        while queue:
            col, row = queue.popleft()
            for dc, dr in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                neighbor = (col + dc, row + dr)
                if neighbor in walkable and neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)
        self.assertEqual(visited, walkable)

    def test_solid_tiles_block_full_body(self):
        for row, line in enumerate(main.CAMPUS):
            for col, tile in enumerate(line):
                if tile in main.SOLID_TILES:
                    self.assertFalse(main.can_stand(col * 32 + 16, row * 32 + 16))
        # Center in clear floor, but body overlaps the right-hand lab wall.
        self.assertFalse(main.can_stand(345, 176))
        self.assertTrue(main.can_stand(340, 176))

    def test_wall_sliding_and_large_move_cannot_tunnel(self):
        player = {'x': 336., 'y': 176.}
        main.move_player(player, 80, 24)
        self.assertLessEqual(player['x'], 340)
        self.assertAlmostEqual(player['y'], 200)
        self.assertTrue(main.can_stand(**player))
        player = {'x': 144., 'y': 368.}
        main.move_player(player, 0, -300)
        self.assertGreaterEqual(player['y'], 332)
        self.assertTrue(main.can_stand(**player))

    def test_both_doorways_allow_entry_and_exit(self):
        for col in (5, 6, 18, 19):
            player = {'x': col * 32 + 16., 'y': 368.}
            main.move_player(player, 0, -96)
            self.assertAlmostEqual(player['y'], 272)
            main.move_player(player, 0, 96)
            self.assertAlmostEqual(player['y'], 368)

    def test_desk_stops_player_and_corner_cannot_be_cut(self):
        for col, row in ((3, 4), (15, 5)):
            player = {'x': col * 32 + 16., 'y': (row + 1) * 32 + 16.}
            main.move_player(player, 0, -96)
            self.assertGreaterEqual(player['y'], (row + 1) * 32 + 12)
            self.assertTrue(main.can_stand(**player))
        player = {'x': 80., 'y': 112.}
        for _ in range(20):
            main.move_player(player, 4.5, 4.5)
            self.assertTrue(main.can_stand(**player))

    def test_lily_pickup_and_give_flow(self):
        previous = main.players.copy()
        try:
            main.players.clear()
            giver = {'id': 'giver', 'name': 'Giver', 'x': 208., 'y': 528., 'facing': 'up', 'state': 'idle',
                     'color': '#f4ce58', 'feedback': '', 'role': 'student', 'terminal_id': None, 'desk_id': None,
                     'bench_id': None, 'solved': set(), 'input': {}, 'lily_id': None}
            receiver = {'id': 'receiver', 'name': 'Receiver', 'x': 208., 'y': 496., 'facing': 'down', 'state': 'idle',
                        'color': '#78bfff', 'feedback': '', 'role': 'student', 'terminal_id': None, 'desk_id': None,
                        'bench_id': None, 'solved': set(), 'input': {}, 'lily_id': None}
            main.players['giver'] = giver
            main.players['receiver'] = receiver
            main.handle_action(giver, {'type': 'interact'})
            self.assertEqual(giver['lily_id'], 'lily-2')
            self.assertIn('picked up', giver['feedback'])
            main.handle_action(giver, {'type': 'interact'})
            self.assertIsNone(giver['lily_id'])
            self.assertEqual(receiver['lily_id'], 'lily-2')
            self.assertIn('gave you a lily', receiver['feedback'])
            self.assertEqual(main.snapshot()['lilies'][1]['holder'], 'receiver')
        finally:
            main.players.clear()
            main.players.update(previous)


if __name__ == '__main__':
    unittest.main()
