import axios from 'axios'
import Nanobar from 'nanobar'
import { diceList } from './constants.js'
import emitter from './events.js'
import router from './router.js'
import store from './store/index.js'

const ASHES_CDN_BASE_URL = import.meta.env.VITE_CDN_URL

/**
 * request(options)
 *
 * A light wrapper around Axios.request() that ensures each request is accompanied by
 * a progress bar.
 *
 * See https://github.com/axios/axios#request-config for options
 *
 * TODO: move support for generic error handling into this method?
 */
export function request(endpoint, options = {}, isRetry = false) {
  // No need to prefix the endpoint if we have a full URL
  if (endpoint.startsWith('http')) {
    options.url = endpoint
  } else {
    if (endpoint.startsWith('/')) endpoint = endpoint.substr(1)
    options.url = `${import.meta.env.VITE_API_URL}/${endpoint}`
  }
  // Always authenticate, if we have a token available
  if (store.getters['player/isAuthenticated']) {
    const authHeader = {
      Authorization: `Bearer ${store.state.player.token}`
    }
    options.headers = {
      ...(options.headers || {}),
      ...authHeader,
    }
  }
  // This is a little gnarly, but I want to have expired tokens automatically handled at a low level
  // so here we are. What happens is that if the authentication fails and the user is authenticated,
  // then we use the global event bus `emitter` from `events.js` to trigger a `login:required`
  // event. This is listened to within the root-level `App.vue` component, which in turn will show
  // the log in modal *while this request Promise is still pending.* Once the login succeeds or
  // fails, then App.vue uses a callback to notify this request. If it succeeds, the request will
  // retry itself, and pass along the ultimate success or failure of the retry. If it fails, the
  // request will simply fail out with the original error.
  return new Promise((resolve, reject) => {
    const nano = new Nanobar({ autoRun: true })
    axios.request(options).then(resolve).catch((error) => {
      // Don't allow a retry to retry itself!
      if (isRetry) {
        return reject(error)
      }
      if (error.response && error.response.status === 401) {
        // If the player is currently authenticated, then that means that their credentials expired.
        // In that case, we'll retry the request
        if (store.getters['player/isAuthenticated']) {
          emitter.emit('login:required', {onSuccess: () => {
            // Sanitize our options and try again
            const endpoint = options.url
            delete options.url
            delete options.headers.Authorization
            request(endpoint, options, true).then(resolve).catch(reject)
          }, onFailure: () => {
            // Since their login failed, we need to clear their credentials
            store.dispatch('RESET_PLAYER')
            // And send them home, just in case the page they are on requires auth
            router.push({name: 'Home'})
            reject('You have been automatically logged out.')
          }})
        } else {
          // Otherwise, they somehow managed to attempt an authenticated request without auth,
          // so just redirect to the login screen
          reject(error)
          router.push({name: 'LogIn'})
        }
        return
      }
    }).finally(() => {
      nano.go(100)
    })
  })
}

/**
 * debounce(callback, wait)
 *
 * Debounces the given callback such that it will only be called a single time after `wait`
 * seconds have elapsed (calling it repeatedly will continue offsetting when it will trigger).
 *
 * The returned function has an additional `cancel()` method that will prevent the
 * the debounced method from triggering. For instance:
 *
 *     const debounced = debounce(myFunction, 1000)
 *     debounced()
 *     debounced.cancel()
 *     // myFunction will never be called
 */
export function debounce(callback, wait) {
  let timeout
  const debounced = (...args) => {
    const context = this
    clearTimeout(timeout)
    timeout = setTimeout(() => callback.apply(context, args), wait)
  }
  debounced.cancel = () => {
    clearTimeout(timeout)
  }
  return debounced
}

/**
 * areSetsEqual(setA, setB)
 *
 * Javascript doesn't have any way to compare set equality, because...Javascript.
 */
export function areSetsEqual(setA, setB) {
  return setA.size === setB.size && [...setA].every(value => setB.has(value))
}

/**
 * trimmed(stringOrFalsey)
 *
 * Ensures that a falsey value is an empty string, and a string has whitespace trimmed. Always
 * returns a string.
 */
export function trimmed(stringOrFalsey) {
  if (!stringOrFalsey) return ''
  return stringOrFalsey.trim()
}

/**
 * capitalize(value)
 *
 * Returns a copy of the given string with the first character capitalized.
 */
export function capitalize (value) {
  if (!value) return value
  return `${value.substr(0, 1).toUpperCase()}${value.substr(1)}`
}

/**
 * jwtPayload(token)
 *
 * Returns the parsed payload object from the given JWT payload (does not attempt to validate it!
 * Don't trust the data you get out!)
 *
 * Source: https://stackoverflow.com/a/38552302/38666
 */
export function jwtPayload(token) {
  const base64Url = token.split('.')[1]
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
  }).join(''))

  return JSON.parse(jsonPayload)
}

/**
 * localStoreFactory(rootKey)
 *
 * Factory funcion for generating local store access functions keyed off rootKey (that is, the
 * local store will include a single rootKey that contains a JSON object with whatever is set
 * via the factory-derived methods).
 */
export function localStoreFactory(rootKey) {
  function storeGetAll () {
    const stored = window.localStorage.getItem(rootKey)
    return stored ? JSON.parse(stored) : {}
  }
  function storeGet (key) {
    const stored = storeGetAll()
    return stored[key]
  }
  function storeSet (key, value) {
    const stored = storeGetAll()
    stored[key] = value
    window.localStorage.setItem(rootKey, JSON.stringify(stored))
  }
  return {
    storeGetAll,
    storeGet,
    storeSet,
  }
}

/**
 * Parses the given input and converts card codes and star formatting into HTML.
 *
 * @param {string} text
 */
export function parseFormattedText (text, ensureParagraphs=false, isLegacy=false) {
  // First make sure that we don't have any HTML in our string; no XSS, thanks
  const unescapedHTML = /[&<"']/g
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '"': '&quot;',
    "'": '&#39;'
  }
  if (unescapedHTML.test(text)) {
    text = text.replace(unescapedHTML, (char) => {
      return escapeMap[char]
    })
  }
  // Parse links and images
  text = text.replace(
    /\[\[(\*?)([^\]]*?)((?:https?:\/\/|\b)[^\s/$.?#]+\.[^\s*]+?)\]\]|(https?:\/\/[^\s/$.?#]+\.[^\s*]+?(?=[.?)][^a-z]|!|\s|$))/ig,
    (_, isImage, text, url, standalone) => {
      let internalLink = false
      const textUrl = url || standalone
      const parsedUrl = textUrl.replace(/^(https?:\/\/)?(.+)$/i, (_, prefix, url) => {
        if (/^ashes\.live(?:\/.*)?$/i.test(url)) {
          internalLink = true
          return 'https://' + url
        } else if (!prefix) {
          return 'http://' + url
        } else {
          return url
        }
      })
      text = text ? text.trim() : null
      if (isImage) {
        return `<a href="${textUrl}"${!internalLink ? ' rel="nofollow external"' : ''} target="_blank"><img class="object-contain" src="${textUrl}" alt=""></a>`
      }
      return `<a href="${parsedUrl}"${!internalLink ? ' rel="nofollow"' : ''}>${text || textUrl}</a>`
    }
  )
  // Parse card codes
  text = text.replace(/\[\[(\*?)((?:[a-z -]|&#39;)+)(?::([a-z]+))?\]\]|( - )/ig, (input, isImage, primary, secondary, dash) => {
    if (dash) {
      return ' <i class="divider"><span class="alt-text">-</span></i> '
    }
    let lowerPrimary = primary.toLowerCase().replace('&#39;', '')
    secondary = secondary && secondary.toLowerCase()
    if (['discard', 'exhaust'].indexOf(lowerPrimary) > -1) {
      return `<i class="phg-${lowerPrimary}" title="${primary}"></i>`
    }

    // Alias "nature" => "natural" (common mistake)
    if (lowerPrimary === 'nature') {
      lowerPrimary = 'natural'
    }
    if (diceList.indexOf(lowerPrimary) > -1) {
      if (!secondary) {
        secondary = 'power'
      }
    } else if (lowerPrimary === 'basic') {
      secondary = 'magic'
    } else if (lowerPrimary === 'main') {
      secondary = 'action'
    } else if (lowerPrimary === 'side') {
      secondary = 'action'
    } else if (secondary) {
      return `<i>${lowerPrimary} ${secondary}</i>`
    } else {
      // We have to escape single quotes that are passed down to a linked component because otherwise Vue translates them back into single quotes and throws an error
      return `<card-link :card="{name: '${primary.replace('&#39;', '\\&#39;')}', stub: '${lowerPrimary.replace(/ +/g, '-')}', is_legacy: ${isLegacy}}"></card-link>`
    }
    return `<i class="phg-${lowerPrimary}-${secondary}" title="${primary}${secondary ? ' ' + secondary : ''}"><span class="alt-text">${input}</span></i>`
  })
  // Parse blockquotes
  text = text.replace(/(^> ?.+?)(?=\n[^>\n])/gm, (match) => {
    return `<blockquote>${match.replace(/^>[ \t]*/gm, '')}</blockquote>`
  })
  text = text.replace('\n</blockquote>', '</blockquote>\n')
  // Parse star formatting
  // * list item
  text = text.replace(/(^|\n|<blockquote>)\*[ ]+(.+)/g, '$1<li>$2</li>')
    .replace('</blockquote></li>', '</li></blockquote>')
    .replace(/(^|\n|<blockquote>)((?:<li>.+?<\/li>\n?)+)(<\/blockquote>|\n|$)/g, '$1<ul>$2</ul>$3')
    .replace(/<\/li>\n+<li>/g, '</li><li>')
    .replace(/<\/li>\n+<\/ul>/g, '</li></ul>\n')
    .replace(/<\/li><\/ul>\n+<li>|<\/li>\n+<ul><li>/g, '</li><li>')
    .replace(/<\/li>$/, '</li></ul>')
  // ~ ordered list item (not typically used for posts, but allows easy conversion between post
  //  syntax and card syntax)
  // Routes through fake element `<oli>` to ensure that we don't screw with unordered lists
  text = text.replace(/(^|\n|<blockquote>)~[ ]+(.+)/g, '$1<oli>$2</oli>')
    .replace('</blockquote></oli>', '</oli></blockquote>')
    .replace(/(^|\n|<blockquote>)((?:<oli>.+?<\/oli>\n?)+)(<\/blockquote>|\n|$)/g, '$1<ol>$2</ol>$3')
    .replace(/<\/oli>\n+<oli>/g, '</oli><oli>')
    .replace(/<\/oli>\n+<\/ol>/g, '</oli></ol>\n')
    .replace(/<\/oli><\/ol>\n+<oli>|<\/oli>\n+<ol><oli>/g, '</oli><oli>')
    .replace(/<(\/?)oli>/g, '<$1li>')
    .replace(/<\/oli>$/, '</oli></ol>')
  // Fix single linebreaks after a block level element (these break the paragraph logic further down)
  text = text.replace(/(<\/(?:blockquote|ul|ol)>\n)(?=[^\n])/g, '$1\n')
  // lone star: *
  text = text.replace(/(^| )\*( |$)/g, '$1&#42;$2')
  // ***emstrong*** or ***em*strong**
  text = text.replace(/\*{3}(.+?)\*(.*?)\*{2}/g, '<b><i>$1</i>$2</b>')
  // ***strong**em*
  text = text.replace(/\*{3}(.+?)\*{2}(.*?)\*/g, '<i><b>$1</b>$2</i>')
  // **strong**
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<b>$1</b>')
  // *emphasis*
  text = text.replace(/\*([^*\n\r]+)\*/g, '<i>$1</i>')
  // Check if we need to further process into paragraphs
  const paragraphs = text.trim().split(/(?:\r\n|\r|\n){2,}/)
  if (paragraphs.length === 1 && !/^<(?:ul|ol|blockquote)>/.test(paragraphs)) {
    return ensureParagraphs ? `<p>${text}</p>` : text
  }
  const composedParagraphs = []
  paragraphs.forEach(paragraph => {
    paragraph = paragraph.replace('\n', '<br>\n')
    composedParagraphs.push(`<p>${paragraph}</p>`)
  })
  text = composedParagraphs.join('\n\n')
  // Correct wrapped lists, blockquotes, and divs
  text = text.replace(/<p>((?:<blockquote>)?<(?:u|o)l>)/g, '$1')
    .replace(/(<\/(?:u|o)l>(?:<\/blockquote>)?)<\/p>/g, '$1')
    .replace('<p><blockquote>', '<blockquote><p>')
    .replace('</blockquote></p>', '</p></blockquote>')
  // Automatically center lone images
  text = text.replace(/<p>(<a class="inline-image".*?<\/a>(?=<\/p>|<br>))/g, '<p style="text-align:center;">$1')
  return text
}

/**
 * Parses card effects into standard HTML.
 *
 * This is in addition to standard card code parsing because card effects need:
 *
 * * Bold ability names
 * * Inexhaustible effect boxes
 * * Blue reaction ability boxes
 *
 * @param {str} text Card effect text to parse
 */
export function parseEffectText (text, isLegacy=false) {
  text = parseFormattedText(text, true, isLegacy)
  // Convert lists to inexhaustible and blue blocks
  text = text.replace('<ul>', '<div class="inexhaustible-effects">')
    .replace('<ol>', '<div class="reaction-effects">')
    .replace(/<\/(?:ul|ol)>/g, '</div>')
    .replace(/<(\/?)li>/g, '<$1p>')
  // Bold ability names (&#39; is apostrophe)
  text = text.replace(/(?:<p>|^)((?:[a-z 0-9]|&#39;)+:)(?= \w| <i class="phg-)/ig, '<p><strong>$1</strong>')
  return text
}

/**
 * Returns phoenixborn image url from the CDN.
 *
 * @param {str} stub Phoenixborn card name
 * @param {str} isLarge If the image to be returned should be the large version
 * @param {bool} isLegacy If the card is from the Ashes 1.0 set as opposed to the Reborn set
 */
export function getPhoenixbornImageUrl(stub, isLarge = false, isLegacy = false) {
  return isLegacy ?
    `${ASHES_CDN_BASE_URL}/legacy/images/cards/${stub}-${isLarge ? 'large' : 'slice'}.jpg` :
    `${ASHES_CDN_BASE_URL}/images/phoenixborn${isLarge ? '' : '-badges'}/${stub}.jpg`
}
