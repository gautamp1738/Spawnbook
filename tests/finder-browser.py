"""Run against `wrangler dev --local --port 8787`. Uses only local test accounts."""
import time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context()
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:8787/finder')
    page.locator('#questionnaire').wait_for(state='visible')
    assert page.locator('#save').is_disabled()
    page.locator('#next').click()
    page.locator('#next').click()
    page.locator('#submit').click()
    page.locator('.finder-card').first.wait_for()
    assert 'undefined' not in page.locator('#matches').inner_text()
    assert page.locator('.finder-card button').first.is_disabled()
    print('PASS anonymous trial, questionnaire, real-data results, sign-in guidance')

    response = context.request.post('http://127.0.0.1:8787/api/signup', form={
        'name': 'Local Finder Test', 'email': f'finder-{time.time_ns()}@example.com',
        'company': 'Local tests', 'role': 'Buyer', 'password': 'Local-Test-Only-8726!', 'agree': 'yes'
    }, headers={'Origin': 'http://127.0.0.1:8787'})
    assert response.ok
    # Production cookies are Secure; explicitly scope them to the local HTTP test server.
    cookies = context.cookies()
    for cookie in cookies:
        cookie['secure'] = False
    context.add_cookies(cookies)
    original = {'genres': [], 'minPlayers': 1, 'notes': 'Keep human review notes', 'avoid': '', 'deal': 'part'}
    saved_response = context.request.post('http://127.0.0.1:8787/api/buybox', data=original, headers={'Origin': 'http://127.0.0.1:8787'})
    assert saved_response.ok, (saved_response.status, saved_response.text(), [c['name'] for c in cookies])
    page.reload()
    page.locator('#questionnaire').wait_for(state='visible')
    assert page.locator('[name=minPlayers]').input_value() == '1'
    assert page.locator('[name=deal]').input_value() == 'part'
    page.locator('#next').click()
    page.locator('#next').click()
    page.locator('[name=minPlayers]').fill('100')
    page.locator('[name=maxPlayers]').fill('10')
    page.locator('#submit').click()
    assert 'must not exceed' in page.locator('#error').inner_text()
    page.locator('[name=minPlayers]').fill('1')
    page.locator('[name=maxPlayers]').fill('')
    page.locator('#save').check()
    page.route('**/api/buybox', lambda route: route.fulfill(status=503, body='Unavailable') if route.request.method == 'POST' else route.continue_())
    page.locator('#submit').click()
    page.get_by_text('Request failed. Please try again.', exact=True).wait_for()
    assert page.locator('#questionnaire').is_visible()
    page.unroute('**/api/buybox')
    page.locator('#submit').click()
    page.locator('.finder-card').first.wait_for()
    assert context.request.get('http://127.0.0.1:8787/api/buybox').json()['box']['notes'] == original['notes']
    button = page.locator('.finder-card button').first
    button.click()
    page.get_by_text('Saved to your watchlist.', exact=True).wait_for()
    assert len(context.request.get('http://127.0.0.1:8787/api/watch').json()['rows']) == 1
    print('PASS existing preferences, validation, opt-in persistence, preserved notes, real watchlist API')
    page.locator('#edit').click()
    page.locator('#next').click()
    page.locator('[name=maxPrice]').fill('1')
    page.locator('#next').click()
    page.locator('#save').uncheck()
    page.locator('#submit').click()
    assert 'No games meet all your limits' in page.locator('#summary').inner_text()
    assert context.request.get('http://127.0.0.1:8787/api/buybox').json()['box']['maxPrice'] is None
    print('PASS empty results and unsaved edits do not overwrite preferences')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.locator('#edit').click()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path='/tmp/spawnbook-finder-mobile.png', full_page=True)
    assert not errors, errors
    print('PASS mobile layout and no browser script errors')
    browser.close()
