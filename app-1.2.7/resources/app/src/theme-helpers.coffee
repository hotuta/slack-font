logger = require('./browser/logger').init(__filename)

# Public: This set of methods are bolted onto both notifications and team selector
# items, and set up the team icon and theme colors
#
# Include it in your class via _.extends(@prototype). It expects to find the
# following properties on the hosting class:
#
#     :content - The root element of the class (from WebComponent)
#     :themeInfo - A hash of the theme information, such as 'initials'
module.exports =
  # Internal: Given a hash of image URL's returned from the SSB,
  # returns reasonable values for the `src` and `srcset` attributes.
  #
  # icons - A hash containing all available team icons along with their sizes
  # targetSize - The default size that will be assigned to `src`
  #
  # Returns an object containing keyed values for `src` and `srscset`
  extractSourceSet: (icons, targetSize='68') ->
    digit = new RegExp("\\d+")
    srcset = ""

    for id, url of icons
      # Images are keyed with the identifier "image_<size>", e.g., "image_68".
      # We need to extract the sizes and build a srcset attribute using them.
      match = digit.exec(id)
      continue unless match?
      size = match[0]

      # Ensure we assign some src
      if not src?
        src = url
      # Target size is the priority, though
      if size is targetSize
        src = url

      srcset += "#{url} #{size}w,\n"

    {src: src, srcset: srcset}

  # Internal: Sets the team icon src and srcset properties
  #
  # icons - A hash containing all available team icons along with their sizes
  # fallbackInitials - Initials to use in case things to pear-shaped with loading
  #                    the image
  #
  # Returns nothing
  setIcons: (icons, fallbackInitials, iconSize='72px') ->
    @showTeamIcon(fallbackInitials, iconSize)

    result = @extractSourceSet(icons)
    teamIcon = @content.querySelector('.notification-icon') || @content.querySelector('.icon')

    teamIcon.src = result.src
    teamIcon.srcset = result.srcset

  # Internal: Sets the team initials on the view
  #
  # Returns nothing
  setInitials: (initials) ->
    @hideTeamIcon()
    @content.querySelector('.initials').textContent = initials

  # Internal: Shows the team icon and hides the team initials.
  #
  # Returns nothing
  showTeamIcon: (fallbackInitials) ->
    initials = fallbackInitials
    initials ?= @themeInfo.initials if @themeInfo?

    teamIcon = @content.querySelector('.notification-icon') || @content.querySelector('.icon')
    teamIcon.style.visibility = 'visible'

    teamIcon.onerror = (error) =>
      logger.warn("Unable to load #{teamIcon.src}, falling back to team initials")
      @setInitials(initials)

    @content.querySelector('.initials').style.visibility = 'hidden'

  # Internal: Hides the team icon and shows the team initials.
  # We squash the size of the icon, otherwise it offsets the placement of the initials.
  #
  # Returns nothing
  hideTeamIcon: ->
    teamIcon = @content.querySelector('.notification-icon') || @content.querySelector('.icon')
    teamIcon.style.visibility = 'hidden'

    @content.querySelector('.initials').style.visibility = 'visible'
