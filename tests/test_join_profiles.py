import unittest
import main


class JoinProfileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.saved = (main.players.copy(), main.reservations.copy(), main.join_profiles.copy())
        main.players.clear()
        main.reservations.clear()
        main.join_profiles.clear()

    def tearDown(self):
        for target, saved in zip((main.players, main.reservations, main.join_profiles), self.saved):
            target.clear()
            target.update(saved)

    async def test_profile_normalized_and_expires_with_ticket(self):
        ticket = await main.join(name='  Mia   Rose  ', character=0, skin=None, hair=None, style=None)
        token = ticket['ws_path'].split('token=')[1]
        self.assertEqual(main.join_profiles[token], {'name': 'Mia Rose', 'character': 0, 'skin': None, 'hair': None, 'style': None})
        main.reservations[token] = 0
        main.expire_reservations()
        self.assertNotIn(token, main.reservations)
        self.assertNotIn(token, main.join_profiles)

    async def test_bad_name_and_full_session_do_not_store_profiles(self):
        with self.assertRaises(main.HTTPException):
            await main.join(name='Bad\x00Name', character=1, skin=None, hair=None, style=None)
        self.assertFalse(main.join_profiles)
        for _ in range(main.MAX_PLAYERS):
            await main.join(name='Student', character=1, skin=None, hair=None, style=None)
        with self.assertRaises(main.HTTPException) as result:
            await main.join(name='Overflow', character=0, skin=None, hair=None, style=None)
        self.assertEqual(result.exception.status_code, 409)
        self.assertEqual(len(main.join_profiles), main.MAX_PLAYERS)
