process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://96091e92f26a43319803240ca4058b56@sentry.cozycloud.cc/116'

const {
  CookieKonnector,
  log,
  utils,
  scrape,
  errors
} = require('cozy-konnector-libs')
const moment = require('moment')

const headers = {
  'User-Agent':
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0 Cozycloud',
  'Accept-Language': 'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3'
}

class FnacConnector extends CookieKonnector {
  async testSession() {
    try {
      if (!this._jar._jar.toJSON().cookies.length) {
        return false
      }
      log('info', 'Testing session')
      await this.requestHtml('https://fnac.com')
      await this.requestHtml(
        `https://secure.fnac.com/MyAccount/Order/GetOrders?DateRangeType=${2}&OrderType=0`,
        {
          followRedirect: false,
          followAllRedirects: false
        }
      )
      log('info', 'Session is OK')
      return true
    } catch (err) {
      log('warn', err.message)
      log('warn', 'Session failed')
      return false
    }
  }

  async fetch(fields) {
    this.initRequestHtml()

    if (!(await this.testSession())) {
      log('info', 'Found no correct session, logging in...')
      await this.authenticate(fields.login, fields.password)
      log('info', 'Successfully logged in')
    }

    const bills = this.formatBills(await this.fetchBills())

    await this.saveBills(bills, fields.folderPath, {
      requestInstance: this.requestHtml,
      identifiers: ['fnac']
    })
  }

  initRequestHtml() {
    this.requestHtml = this.requestFactory({
      // debug: true,
      cheerio: true,
      json: false,
      headers
    })
  }

  formatBills(bills) {
    const VENDOR = 'Fnac'
    return bills.map(bill => ({
      ...bill,
      vendor: VENDOR,
      currency: '€',
      filename: `${utils.formatDate(bill.date)}_${VENDOR}_${bill.amount.toFixed(
        2
      )}€_${bill.vendorRef}.pdf`,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    }))
  }

  async fetchBills() {
    let result = []
    for (const dateRangeType of [3, 4, 5, 6]) {
      const $ = await this.requestHtml(
        `https://secure.fnac.com/MyAccount/Order/GetOrders?DateRangeType=${dateRangeType}&OrderType=0`
      )

      const bills = scrape(
        $,
        {
          vendorRef: {
            sel: 'div',
            fn: $el => $el.closest('section').data('order-id')
          },
          date: {
            sel: '.ma-OrderTop>div>div>span:nth-child(1)',
            parse: date => moment(date, 'DD/MM/YYYY').toDate()
          },
          amount: {
            sel: '.ma-orderdetails-price, .ma-OrderDetails-price',
            parse: normalizePrice
          },
          fileurl: {
            sel: ".ma-OrderDetails-Link[href^='javascript']",
            attr: 'href',
            parse: href => href && href.match(/(https.*)'\)$/)[1]
          }
        },
        '.ma-Order'
      )

      result = result.concat(bills)
    }

    result = result.filter(bill => bill.fileurl)

    return result
  }

  // Cookie .AUTH and cookie UID seems mandatory to be connected
  async authenticate(username, password) {
    // Prefecth Oauth URL and token
    let firstOauthUrl = ''
    try {
      await this.requestHtml({
        followRedirect: false,
        uri:
          'https://secure.fnac.com/identity/gateway/signin?LogonType=StandardCreation&PageRedir=https://www.fnac.com/',
        followAllRedirects: false,
        resolveWithFullResponse: true
      })
    } catch (err) {
      if (err.statusCode === 302) {
        firstOauthUrl = err.response.headers.location
      } else if (err.statusCode === 403) {
        log('error', err.message)
        log('error', 'captcha url')
        const captchaUrl = JSON.parse(err.message.match(/({.*})/)[1]).url
        const captchaPage = await this.requestHtml(captchaUrl)
        log('error', captchaPage.html())
        throw new Error(errors.CAPTCHA_RESOLUTION_FAILED)
      } else {
        throw err
      }
    }
    // Finish to follow 302
    await this.requestHtml(firstOauthUrl)

    const authorize_request_identifier = this._jar
      .getCookies('https://secure.fnac.com')
      .find(cookie => cookie.key === 'authorize_request_identifier').value
    log('debug', 'First login step ok, get authorize_request_identifier')

    // First POST to API to get an OpenID token
    try {
      const reqPostApi = await this.request({
        url: 'https://secure.fnac.com/identity/server/api/v1/login',
        method: 'POST',
        headers: {
          authorization: 'Basic 23A17F49D34DE16BC85AB395F',
          accept: '*/*'
        },
        body: {
          authenticationLocation: 'StandardCreation - Account',
          authorizeRequestIdentifier: authorize_request_identifier,
          email: username,
          password: password,
          redirectUri: firstOauthUrl
        }
      })
      const OAuthUrl = reqPostApi.RedirectUri
      log('info', 'Account seems valid')
      log('debug', 'Second login step ok, get an Oauth link')
      // Do a Oauth process with signin (GET then POST)
      await this.signin({
        url: OAuthUrl,
        requestInstance: this.requestHtml,
        formSelector: 'form'
      })
      log('debug', 'Third login step ok, logged back to fnac.com')
    } catch (err) {
      log('error', err.message)
      throw new Error(errors.LOGIN_FAILED)
    }
  }
}

// convert a price string to a float
function normalizePrice(price) {
  return parseFloat(
    price
      .replace('€', '')
      .replace(',', '.')
      .trim()
  )
}

const connector = new FnacConnector({
  // debug: ({ strings: { headers, oneline } }) => {
  //   log('info', oneline)
  //   log('info', headers)
  // },
  cheerio: false,
  json: true,
  headers
})

connector.run()
