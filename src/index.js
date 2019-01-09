const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')
let request = requestFactory()
let j = request.jar()
request = requestFactory({
  debug: true,
  cheerio: false,
  json: false,
  jar: j
})

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  //  await request('https://fnac.com')
  log('info', 'Fetching the list of documents')
  //cheerio TODO
  const $ = await request(`https://secure.fnac.com/MyAccount/Order`)
  return
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['books']
  })
}

// Cookie .AUTH and cookie UID seems mandatory to be connected
async function authenticate(username, password) {
  // Prefecth Oauth URL and token
  let firstOauthUrl = ''
  try {
    const firstReq = await request({
      followRedirect: false,
      uri: 'https://secure.fnac.com/identity/gateway/signin',
      followAllRedirects: false
    })
  } catch (err) {
    if (err.statusCode === 302) {
      firstOauthUrl = err.response.headers.location
    } else {
      throw err
    }
  }
  console.log(firstOauthUrl)
  // Finish to follow 302
  await request(firstOauthUrl)

  const authorize_request_identifier = j
    .getCookies('https://secure.fnac.com')
    .find(cookie => cookie.key === 'authorize_request_identifier').value
  log('debug', 'First login step ok, get authorize_request_identifier')

  // First POST to API to get an OpenID token
  const reqPostApi = await request({
    url: 'https://secure.fnac.com/identity/server/api/v1/login',
    method: 'POST',
    headers: {
      authorization: 'Basic 23A17F49D34DE16BC85AB395F' //not needed maybe
    },
    form: {
      authenticationLocation: 'StandardCreation - Account',
      authorizeRequestIdentifier: authorize_request_identifier,
      email: username,
      password: password,
      redirectUri: firstOauthUrl
    }
  })
  const OAuthUrl = JSON.parse(reqPostApi).RedirectUri

  // LOGIN FAILED
  log('info', 'Account seems valid')
  log('debug', 'Second login step ok, get an Oauth link')
  console.log(OAuthUrl)
  // Do a Oauth process with signin (GET then POST)
  await signin({
    url: OAuthUrl,
    formSelector: 'form'
  })
  log('debug', 'Third login step ok, logged back to fnac.com')

  // What's BAD :
  // .AUTH cookie not set at  complete-login
  // Order page redirect to a login process
  return
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseDocuments($) {
  // you can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      title: {
        sel: 'h3 a',
        attr: 'title'
      },
      amount: {
        sel: '.price_color',
        parse: normalizePrice
      },
      fileurl: {
        sel: 'img',
        attr: 'src',
        parse: src => `${baseUrl}/${src}`
      },
      filename: {
        sel: 'h3 a',
        attr: 'title',
        parse: title => `${title}.jpg`
      }
    },
    'article'
  )
  return docs.map(doc => ({
    ...doc,
    // the saveBills function needs a date field
    // even if it is a little artificial here (these are not real bills)
    date: new Date(),
    currency: '€',
    vendor: 'template',
    metadata: {
      // it can be interesting that we add the date of import. This is not mandatory but may be
      // useful for debugging or data migration
      importDate: new Date(),
      // document version, useful for migration after change of document structure
      version: 1
    }
  }))
}

// convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace('£', '').trim())
}
