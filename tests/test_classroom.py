import unittest
import main


class ClassroomTests(unittest.TestCase):
    def setUp(self):
        self.saved = main.players.copy()
        main.players.clear()
        main.chat.clear()
        main.lecture.update(notes='', highlight=-1)
        for name in ('a', 'b'):
            main.players[name] = {'id': name, 'role': 'student', 'x': 592., 'y': 144.,
                'state': 'idle', 'terminal_id': None, 'desk_id': None,
                'input': {}, 'feedback': '', 'solved': set()}
        self.a, self.b = main.players.values()

    def tearDown(self):
        main.players.clear()
        main.players.update(self.saved)
        main.chat.clear()
        main.lecture.update(notes='', highlight=-1)

    def act(self, player, action, **extra):
        main.handle_action(player, dict(type=action, **extra))

    def test_exclusive_teacher_and_student_rejection(self):
        self.act(self.a, 'claim_teacher')
        self.act(self.b, 'claim_teacher')
        self.assertEqual(main.teacher_id(), 'a')
        self.act(self.b, 'interact')
        self.assertEqual(self.b['state'], 'idle')
        self.act(self.b, 'publish_notes', text='Spoofed')
        self.assertEqual(main.lecture['notes'], '')

    def test_podium_required_and_notes_highlight_validation(self):
        self.act(self.a, 'claim_teacher')
        self.act(self.a, 'publish_notes', text='Not started')
        self.assertEqual(main.lecture['notes'], '')
        self.act(self.a, 'interact')
        self.assertEqual(self.a['state'], 'lecturing')
        self.act(self.a, 'publish_notes', text='Loops\nrange(3)')
        self.act(self.b, 'highlight_line', line=1)
        self.assertEqual(main.lecture['highlight'], -1)
        self.act(self.a, 'highlight_line', line=1)
        self.assertEqual(main.lecture['highlight'], 1)
        for bad in (True, 20, -2, '1'):
            self.act(self.a, 'highlight_line', line=bad)
            self.assertEqual(main.lecture['highlight'], 1)
        for bad in ('x' * 601, '\n'.join(['x'] * 11), [], ''):
            self.act(self.a, 'publish_notes', text=bad)
            self.assertEqual(main.lecture['notes'], 'Loops\nrange(3)')
        self.a['y'] = 400
        self.act(self.a, 'publish_notes', text='Remote')
        self.assertEqual(main.lecture['notes'], 'Loops\nrange(3)')

    def test_end_and_disconnect_release_teacher_and_board(self):
        self.act(self.a, 'claim_teacher')
        self.act(self.a, 'interact')
        self.act(self.a, 'publish_notes', text='Lesson')
        self.act(self.a, 'leave_terminal')  # Older client exit action also cleans up a lecture.
        self.assertIsNone(main.lecturer_id())
        self.assertEqual(main.lecture['notes'], '')
        self.assertEqual(main.teacher_id(), 'a')
        self.act(self.a, 'interact')
        self.act(self.a, 'publish_notes', text='Lesson two')
        main.remove_player('a')
        self.assertIsNone(main.teacher_id())
        self.assertEqual(main.lecture['notes'], '')
        self.act(self.b, 'claim_teacher')
        self.assertEqual(main.teacher_id(), 'b')

    def test_desk_exclusivity_and_leave(self):
        desk = main.DESKS[0]
        for p in (self.a, self.b):
            p.update(x=desk['x'], y=desk['y'] + 32)
            self.act(p, 'interact')
        self.assertEqual(self.a['desk_id'], desk['id'])
        self.assertIsNone(self.b['desk_id'])
        self.act(self.a, 'leave_activity')
        self.act(self.b, 'interact')
        self.assertEqual(self.b['desk_id'], desk['id'])
        for desk in main.DESKS:
            self.assertTrue(main.can_stand(desk['x'], desk['y'] + 32))

    def test_chat_validation_rate_limit_and_bounded_history(self):
        for text in (None, [], '', 'x' * 241):
            self.act(self.a, 'chat', text=text)
        self.assertFalse(main.chat)
        self.act(self.a, 'chat', text='<img src=x onerror=alert(1)>')
        self.assertEqual(main.chat[-1]['player_id'], 'a')
        self.act(self.a, 'chat', text='Too soon')
        self.assertEqual(len(main.chat), 1)
        for i in range(60):
            self.a['last_chat'] = -10
            self.act(self.a, 'chat', text=str(i))
        self.assertEqual(len(main.chat), 50)
        self.assertEqual(main.chat[-1]['text'], '59')
