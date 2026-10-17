import sys
import unittest

def load_tests(loader, standard_tests, pattern):
    suite = unittest.TestSuite()
    if 'backend' in sys.argv:
        from tests import test_server
        suite.addTests(loader.loadTestsFromModule(test_server))
    return suite

