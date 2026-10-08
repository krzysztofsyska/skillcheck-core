-- SC-SALES-006B. No runtime credentials or initial operator. Disabled by default.
begin;
do $$
declare installed_schema text;
begin
  select n.nspname into installed_schema from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';
  if installed_schema is null then
    create schema if not exists extensions;
    create extension pgcrypto with schema extensions;
  elsif installed_schema <> 'extensions' then
    raise exception 'sales_lead_pgcrypto_schema';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='extensions' and p.proname='hmac'
    and pg_catalog.pg_get_function_identity_arguments(p.oid)='text, text, text') then
    raise exception 'sales_lead_pgcrypto_hmac';
  end if;
end $$;

-- Same pinned Unicode 17.0 map as the signing helper; never use locale-dependent lower().
create function private.sales_lead_lower_email(value text) returns text
language sql immutable strict set search_path = '' as $$
  select pg_catalog.replace(pg_catalog.translate(value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠƢƤƦƧƩƬƮƯƱƲƳƵƷƸƼǄǅǇǈǊǋǍǏǑǓǕǗǙǛǞǠǢǤǦǨǪǬǮǱǲǴǶǷǸǺǼǾȀȂȄȆȈȊȌȎȐȒȔȖȘȚȜȞȠȢȤȦȨȪȬȮȰȲȺȻȽȾɁɃɄɅɆɈɊɌɎͰͲͶͿΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫϏϘϚϜϞϠϢϤϦϨϪϬϮϴϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯѠѢѤѦѨѪѬѮѰѲѴѶѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӃӅӇӉӋӍӐӒӔӖӘӚӜӞӠӢӤӦӨӪӬӮӰӲӴӶӸӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍᎠᎡᎢᎣᎤᎥᎦᎧᎨᎩᎪᎫᎬᎭᎮᎯᎰᎱᎲᎳᎴᎵᎶᎷᎸᎹᎺᎻᎼᎽᎾᎿᏀᏁᏂᏃᏄᏅᏆᏇᏈᏉᏊᏋᏌᏍᏎᏏᏐᏑᏒᏓᏔᏕᏖᏗᏘᏙᏚᏛᏜᏝᏞᏟᏠᏡᏢᏣᏤᏥᏦᏧᏨᏩᏪᏫᏬᏭᏮᏯᏰᏱᏲᏳᏴᏵᲉᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẞẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾἈἉἊἋἌἍἎἏἘἙἚἛἜἝἨἩἪἫἬἭἮἯἸἹἺἻἼἽἾἿὈὉὊὋὌὍὙὛὝὟὨὩὪὫὬὭὮὯᾈᾉᾊᾋᾌᾍᾎᾏᾘᾙᾚᾛᾜᾝᾞᾟᾨᾩᾪᾫᾬᾭᾮᾯᾸᾹᾺΆᾼῈΈῊΉῌῘῙῚΊῨῩῪΎῬῸΌῺΏῼΩKÅℲⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯↃⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟋꟌ꟎Ꟑ꟒꟔ꟖꟘꟚꟜꟵＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇𐐈𐐉𐐊𐐋𐐌𐐍𐐎𐐏𐐐𐐑𐐒𐐓𐐔𐐕𐐖𐐗𐐘𐐙𐐚𐐛𐐜𐐝𐐞𐐟𐐠𐐡𐐢𐐣𐐤𐐥𐐦𐐧𐒰𐒱𐒲𐒳𐒴𐒵𐒶𐒷𐒸𐒹𐒺𐒻𐒼𐒽𐒾𐒿𐓀𐓁𐓂𐓃𐓄𐓅𐓆𐓇𐓈𐓉𐓊𐓋𐓌𐓍𐓎𐓏𐓐𐓑𐓒𐓓𐕰𐕱𐕲𐕳𐕴𐕵𐕶𐕷𐕸𐕹𐕺𐕼𐕽𐕾𐕿𐖀𐖁𐖂𐖃𐖄𐖅𐖆𐖇𐖈𐖉𐖊𐖌𐖍𐖎𐖏𐖐𐖑𐖒𐖔𐖕𐲀𐲁𐲂𐲃𐲄𐲅𐲆𐲇𐲈𐲉𐲊𐲋𐲌𐲍𐲎𐲏𐲐𐲑𐲒𐲓𐲔𐲕𐲖𐲗𐲘𐲙𐲚𐲛𐲜𐲝𐲞𐲟𐲠𐲡𐲢𐲣𐲤𐲥𐲦𐲧𐲨𐲩𐲪𐲫𐲬𐲭𐲮𐲯𐲰𐲱𐲲𐵐𐵑𐵒𐵓𐵔𐵕𐵖𐵗𐵘𐵙𐵚𐵛𐵜𐵝𐵞𐵟𐵠𐵡𐵢𐵣𐵤𐵥𑢠𑢡𑢢𑢣𑢤𑢥𑢦𑢧𑢨𑢩𑢪𑢫𑢬𑢭𑢮𑢯𑢰𑢱𑢲𑢳𑢴𑢵𑢶𑢷𑢸𑢹𑢺𑢻𑢼𑢽𑢾𑢿𖹀𖹁𖹂𖹃𖹄𖹅𖹆𖹇𖹈𖹉𖹊𖹋𖹌𖹍𖹎𖹏𖹐𖹑𖹒𖹓𖹔𖹕𖹖𖹗𖹘𖹙𖹚𖹛𖹜𖹝𖹞𖹟𖺠𖺡𖺢𖺣𖺤𖺥𖺦𖺧𖺨𖺩𖺪𖺫𖺬𖺭𖺮𖺯𖺰𖺱𖺲𖺳𖺴𖺵𖺶𖺷𖺸𞤀𞤁𞤂𞤃𞤄𞤅𞤆𞤇𞤈𞤉𞤊𞤋𞤌𞤍𞤎𞤏𞤐𞤑𞤒𞤓𞤔𞤕𞤖𞤗𞤘𞤙𞤚𞤛𞤜𞤝𞤞𞤟𞤠𞤡', 'abcdefghijklmnopqrstuvwxyzàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįĳĵķĺļľŀłńņňŋōŏőœŕŗřśŝşšţťŧũūŭůűųŵŷÿźżžɓƃƅɔƈɖɗƌǝəɛƒɠɣɩɨƙɯɲɵơƣƥʀƨʃƭʈưʊʋƴƶʒƹƽǆǆǉǉǌǌǎǐǒǔǖǘǚǜǟǡǣǥǧǩǫǭǯǳǳǵƕƿǹǻǽǿȁȃȅȇȉȋȍȏȑȓȕȗșțȝȟƞȣȥȧȩȫȭȯȱȳⱥȼƚⱦɂƀʉʌɇɉɋɍɏͱͳͷϳάέήίόύώαβγδεζηθικλμνξοπρστυφχψωϊϋϗϙϛϝϟϡϣϥϧϩϫϭϯθϸϲϻͻͼͽѐёђѓєѕіїјљњћќѝўџабвгдежзийклмнопрстуфхцчшщъыьэюяѡѣѥѧѩѫѭѯѱѳѵѷѹѻѽѿҁҋҍҏґғҕҗҙқҝҟҡңҥҧҩҫҭүұҳҵҷҹһҽҿӏӂӄӆӈӊӌӎӑӓӕӗәӛӝӟӡӣӥӧөӫӭӯӱӳӵӷӹӻӽӿԁԃԅԇԉԋԍԏԑԓԕԗԙԛԝԟԡԣԥԧԩԫԭԯաբգդեզէըթժիլխծկհձղճմյնշոչպջռսվտրցւփքօֆⴀⴁⴂⴃⴄⴅⴆⴇⴈⴉⴊⴋⴌⴍⴎⴏⴐⴑⴒⴓⴔⴕⴖⴗⴘⴙⴚⴛⴜⴝⴞⴟⴠⴡⴢⴣⴤⴥⴧⴭꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿᏸᏹᏺᏻᏼᏽᲊაბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰჱჲჳჴჵჶჷჸჹჺჽჾჿḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕßạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹỻỽỿἀἁἂἃἄἅἆἇἐἑἒἓἔἕἠἡἢἣἤἥἦἧἰἱἲἳἴἵἶἷὀὁὂὃὄὅὑὓὕὗὠὡὢὣὤὥὦὧᾀᾁᾂᾃᾄᾅᾆᾇᾐᾑᾒᾓᾔᾕᾖᾗᾠᾡᾢᾣᾤᾥᾦᾧᾰᾱὰάᾳὲέὴήῃῐῑὶίῠῡὺύῥὸόὼώῳωkåⅎⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻⅼⅽⅾⅿↄⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩⰰⰱⰲⰳⰴⰵⰶⰷⰸⰹⰺⰻⰼⰽⰾⰿⱀⱁⱂⱃⱄⱅⱆⱇⱈⱉⱊⱋⱌⱍⱎⱏⱐⱑⱒⱓⱔⱕⱖⱗⱘⱙⱚⱛⱜⱝⱞⱟⱡɫᵽɽⱨⱪⱬɑɱɐɒⱳⱶȿɀⲁⲃⲅⲇⲉⲋⲍⲏⲑⲓⲕⲗⲙⲛⲝⲟⲡⲣⲥⲧⲩⲫⲭⲯⲱⲳⲵⲷⲹⲻⲽⲿⳁⳃⳅⳇⳉⳋⳍⳏⳑⳓⳕⳗⳙⳛⳝⳟⳡⳣⳬⳮⳳꙁꙃꙅꙇꙉꙋꙍꙏꙑꙓꙕꙗꙙꙛꙝꙟꙡꙣꙥꙧꙩꙫꙭꚁꚃꚅꚇꚉꚋꚍꚏꚑꚓꚕꚗꚙꚛꜣꜥꜧꜩꜫꜭꜯꜳꜵꜷꜹꜻꜽꜿꝁꝃꝅꝇꝉꝋꝍꝏꝑꝓꝕꝗꝙꝛꝝꝟꝡꝣꝥꝧꝩꝫꝭꝯꝺꝼᵹꝿꞁꞃꞅꞇꞌɥꞑꞓꞗꞙꞛꞝꞟꞡꞣꞥꞧꞩɦɜɡɬɪʞʇʝꭓꞵꞷꞹꞻꞽꞿꟁꟃꞔʂᶎꟈꟊɤꟍ꟏ꟑꟓꟕꟗꟙꟛƛꟶａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ𐐨𐐩𐐪𐐫𐐬𐐭𐐮𐐯𐐰𐐱𐐲𐐳𐐴𐐵𐐶𐐷𐐸𐐹𐐺𐐻𐐼𐐽𐐾𐐿𐑀𐑁𐑂𐑃𐑄𐑅𐑆𐑇𐑈𐑉𐑊𐑋𐑌𐑍𐑎𐑏𐓘𐓙𐓚𐓛𐓜𐓝𐓞𐓟𐓠𐓡𐓢𐓣𐓤𐓥𐓦𐓧𐓨𐓩𐓪𐓫𐓬𐓭𐓮𐓯𐓰𐓱𐓲𐓳𐓴𐓵𐓶𐓷𐓸𐓹𐓺𐓻𐖗𐖘𐖙𐖚𐖛𐖜𐖝𐖞𐖟𐖠𐖡𐖣𐖤𐖥𐖦𐖧𐖨𐖩𐖪𐖫𐖬𐖭𐖮𐖯𐖰𐖱𐖳𐖴𐖵𐖶𐖷𐖸𐖹𐖻𐖼𐳀𐳁𐳂𐳃𐳄𐳅𐳆𐳇𐳈𐳉𐳊𐳋𐳌𐳍𐳎𐳏𐳐𐳑𐳒𐳓𐳔𐳕𐳖𐳗𐳘𐳙𐳚𐳛𐳜𐳝𐳞𐳟𐳠𐳡𐳢𐳣𐳤𐳥𐳦𐳧𐳨𐳩𐳪𐳫𐳬𐳭𐳮𐳯𐳰𐳱𐳲𐵰𐵱𐵲𐵳𐵴𐵵𐵶𐵷𐵸𐵹𐵺𐵻𐵼𐵽𐵾𐵿𐶀𐶁𐶂𐶃𐶄𐶅𑣀𑣁𑣂𑣃𑣄𑣅𑣆𑣇𑣈𑣉𑣊𑣋𑣌𑣍𑣎𑣏𑣐𑣑𑣒𑣓𑣔𑣕𑣖𑣗𑣘𑣙𑣚𑣛𑣜𑣝𑣞𑣟𖹠𖹡𖹢𖹣𖹤𖹥𖹦𖹧𖹨𖹩𖹪𖹫𖹬𖹭𖹮𖹯𖹰𖹱𖹲𖹳𖹴𖹵𖹶𖹷𖹸𖹹𖹺𖹻𖹼𖹽𖹾𖹿𖺻𖺼𖺽𖺾𖺿𖻀𖻁𖻂𖻃𖻄𖻅𖻆𖻇𖻈𖻉𖻊𖻋𖻌𖻍𖻎𖻏𖻐𖻑𖻒𖻓𞤢𞤣𞤤𞤥𞤦𞤧𞤨𞤩𞤪𞤫𞤬𞤭𞤮𞤯𞤰𞤱𞤲𞤳𞤴𞤵𞤶𞤷𞤸𞤹𞤺𞤻𞤼𞤽𞤾𞤿𞥀𞥁𞥂𞥃'), U&'\0130', U&'i\0307');
$$;
revoke all on function private.sales_lead_lower_email(text) from public, anon, authenticated;

create table public.sales_leads (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  first_name text not null check (char_length(first_name) between 1 and 80),
  company_name text not null check (char_length(company_name) between 1 and 160),
  email text not null check (char_length(email) between 3 and 254),
  phone text check (phone is null or char_length(phone) between 5 and 32),
  needs text not null check (char_length(needs) between 10 and 1000),
  status text not null default 'received' check (status='received'),
  submitted_by uuid,
  fingerprint_hash text not null check (fingerprint_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index sales_leads_email_time on public.sales_leads(email,created_at);
create index sales_leads_source_time on public.sales_leads(fingerprint_hash,created_at);
create index sales_leads_time on public.sales_leads(created_at);
create table public.platform_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz check (revoked_at is null or revoked_at>=granted_at)
);
create table private.sales_lead_settings (
  id boolean primary key default true check(id),
  leads_enabled boolean not null default false,
  request_secret_current text check (request_secret_current is null or octet_length(request_secret_current)>=32),
  request_secret_previous text check (request_secret_previous is null or octet_length(request_secret_previous)>=32),
  request_secret_rotated_at timestamptz
);
insert into private.sales_lead_settings(id) values(true);
create table private.sales_lead_attempts (
  id bigint generated always as identity primary key,
  fingerprint_hash text not null,
  attempted_at timestamptz not null default now(),
  result text not null check (result in ('accepted','rejected','rate_limited'))
);
create index sales_lead_attempts_source_time on private.sales_lead_attempts(fingerprint_hash,attempted_at);
create index sales_lead_attempts_time on private.sales_lead_attempts(attempted_at);
create table private.sales_lead_replay_state (
  lead_id uuid primary key references public.sales_leads(id),
  replay_count integer not null check (replay_count between 1 and 20),
  last_replay_at timestamptz not null default now()
);
alter table public.sales_leads enable row level security;
alter table public.platform_operators enable row level security;
revoke all on public.sales_leads,public.platform_operators from public,anon,authenticated;
revoke all on private.sales_lead_settings,private.sales_lead_attempts,private.sales_lead_replay_state from public,anon,authenticated;
revoke all on sequence private.sales_lead_attempts_id_seq from public,anon,authenticated;

create function private.sales_lead_settings_history() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.request_secret_previous is not null then
    if new.request_secret_previous is null and (old.request_secret_rotated_at is null or clock_timestamp()<old.request_secret_rotated_at+interval '60 minutes') then
      raise exception 'sales_lead_secret_history_open';
    elsif new.request_secret_previous is not null and new.request_secret_previous is distinct from old.request_secret_previous then
      raise exception 'sales_lead_secret_rotation_busy';
    end if;
    if new.request_secret_rotated_at is distinct from old.request_secret_rotated_at then
      raise exception 'sales_lead_secret_history_open';
    end if;
  elsif new.request_secret_previous is not null then
    if new.request_secret_rotated_at is null or new.request_secret_rotated_at < statement_timestamp() then
      raise exception 'sales_lead_secret_history_open';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.sales_lead_settings_history() from public,anon,authenticated;
create trigger sales_lead_settings_history before update on private.sales_lead_settings for each row execute function private.sales_lead_settings_history();

create function private.rotate_sales_lead_request_secret(new_secret text) returns void language plpgsql security definer set search_path='' as $$
declare s private.sales_lead_settings%rowtype;
begin
  select * into s from private.sales_lead_settings where id for update;
  if new_secret is null or octet_length(new_secret)<32 then raise exception 'sales_lead_secret_invalid'; end if;
  if s.request_secret_previous is not null then raise exception 'sales_lead_secret_rotation_busy'; end if;
  update private.sales_lead_settings set request_secret_current=new_secret,
    request_secret_previous=s.request_secret_current,
    request_secret_rotated_at=case when s.request_secret_current is null then null else clock_timestamp() end where id;
end $$;
revoke all on function private.rotate_sales_lead_request_secret(text) from public,anon,authenticated;
create function private.retire_sales_lead_previous_secret() returns void language plpgsql security definer set search_path='' as $$
declare s private.sales_lead_settings%rowtype;
begin
  select * into s from private.sales_lead_settings where id for update;
  if s.request_secret_previous is null then return; end if;
  if s.request_secret_rotated_at is null or clock_timestamp()<s.request_secret_rotated_at+interval '60 minutes' then
    raise exception 'sales_lead_secret_history_open';
  end if;
  update private.sales_lead_settings set request_secret_previous=null where id;
end $$;
revoke all on function private.retire_sales_lead_previous_secret() from public,anon,authenticated;

create function private.sales_leads_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' and current_setting('skillcheck.sales_lead_test_purge',true)='on' then return old; end if;
  if tg_op='UPDATE' and current_setting('skillcheck.sales_lead_author_detach',true)='on'
    and old.submitted_by is not null and new.submitted_by is null
    and (to_jsonb(old)-'submitted_by')=(to_jsonb(new)-'submitted_by') then return new; end if;
  raise exception 'sales_lead_immutable';
end $$;
revoke all on function private.sales_leads_immutable() from public,anon,authenticated;
create trigger sales_leads_immutable before update or delete on public.sales_leads for each row execute function private.sales_leads_immutable();
create function private.detach_sales_lead_author(target_user uuid) returns void language plpgsql security definer set search_path='' as $$
declare previous_value text := current_setting('skillcheck.sales_lead_author_detach',true);
begin
  perform set_config('skillcheck.sales_lead_author_detach','on',true);
  update public.sales_leads set submitted_by=null where submitted_by=target_user;
  perform set_config('skillcheck.sales_lead_author_detach',coalesce(previous_value,''),true);
end $$;
revoke all on function private.detach_sales_lead_author(uuid) from public,anon,authenticated;
create function private.sales_lead_user_deleted() returns trigger language plpgsql security definer set search_path='' as $$
begin perform private.detach_sales_lead_author(old.id); return old; end $$;
revoke all on function private.sales_lead_user_deleted() from public,anon,authenticated;
create trigger sales_lead_user_deleted after delete on auth.users for each row execute function private.sales_lead_user_deleted();
create function private.purge_sales_leads(lead_ids uuid[]) returns void language plpgsql security definer set search_path='' as $$
declare previous_value text := current_setting('skillcheck.sales_lead_test_purge',true);
begin
  perform set_config('skillcheck.sales_lead_test_purge','on',true);
  delete from private.sales_lead_replay_state where lead_id=any(lead_ids);
  delete from public.sales_leads where id=any(lead_ids);
  perform set_config('skillcheck.sales_lead_test_purge',coalesce(previous_value,''),true);
end $$;
revoke all on function private.purge_sales_leads(uuid[]) from public,anon,authenticated;
create function private.purge_expired_sales_lead_attempts() returns void language plpgsql security definer set search_path='' as $$
begin delete from private.sales_lead_attempts where attempted_at<clock_timestamp()-interval '48 hours'; end $$;
revoke all on function private.purge_expired_sales_lead_attempts() from public,anon,authenticated;

create function private.is_platform_operator(target_user uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin return exists(select 1 from public.platform_operators where user_id=target_user and revoked_at is null); end $$;
revoke all on function private.is_platform_operator(uuid) from public,anon,authenticated;
grant execute on function private.is_platform_operator(uuid) to authenticated;
create function public.platform_operator_status() returns boolean language plpgsql security definer set search_path='' as $$
begin return private.is_platform_operator((select auth.uid())); end $$;
revoke all on function public.platform_operator_status() from public,anon,authenticated;
grant execute on function public.platform_operator_status() to authenticated;
create function public.list_sales_leads(result_limit integer default 50) returns setof public.sales_leads language plpgsql security definer set search_path='' as $$
begin
  if not private.is_platform_operator((select auth.uid())) then raise exception 'sales_lead_forbidden'; end if;
  return query select * from public.sales_leads order by created_at desc,id desc limit greatest(1,least(100,coalesce(result_limit,50)));
end $$;
revoke all on function public.list_sales_leads(integer) from public,anon,authenticated;
grant execute on function public.list_sales_leads(integer) to authenticated;
create function public.grant_platform_operator(target_user uuid) returns text language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(6105,1);
  perform 1 from public.platform_operators where user_id=(select auth.uid()) and revoked_at is null for update;
  if not found then return 'sales_lead_forbidden'; end if;
  if not exists(select 1 from auth.users where id=target_user) then return 'sales_lead_invalid'; end if;
  insert into public.platform_operators(user_id,granted_by) values(target_user,(select auth.uid()))
    on conflict(user_id) do update set revoked_at=null,granted_by=excluded.granted_by;
  return 'ok';
end $$;
revoke all on function public.grant_platform_operator(uuid) from public,anon,authenticated;
grant execute on function public.grant_platform_operator(uuid) to authenticated;
create function public.revoke_platform_operator(target_user uuid) returns text language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(6105,1);
  perform 1 from public.platform_operators where user_id=(select auth.uid()) and revoked_at is null for update;
  if not found then return 'sales_lead_forbidden'; end if;
  if exists(select 1 from public.platform_operators where user_id=target_user and revoked_at is null)
    and (select count(*) from public.platform_operators where revoked_at is null)=1 then return 'sales_lead_last_operator'; end if;
  update public.platform_operators set revoked_at=clock_timestamp() where user_id=target_user and revoked_at is null;
  return 'ok';
end $$;
revoke all on function public.revoke_platform_operator(uuid) from public,anon,authenticated;
grant execute on function public.revoke_platform_operator(uuid) to authenticated;

create function public.submit_sales_lead(idempotency_key uuid, first_name text, company_name text, email text, phone text, needs text,
  source_ip text, issued_at_us bigint, request_signature text) returns table(lead_id uuid,result_code text)
language plpgsql security definer set search_path='' as $$
declare
  s private.sales_lead_settings%rowtype;
  existing public.sales_leads%rowtype;
  fn text; cn text; em text; ph text; ne text;
  canonical text; fp text; fps text[]; received_at timestamptz;
  caller uuid := (select auth.uid());
  has_existing boolean; fields_valid boolean; ip_valid boolean := false;
  address inet; octet text;
  -- Explicit ECMAScript whitespace set, independent of the database locale.
  ws text := U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]';
begin
  lead_id:=null;
  result_code:='sales_lead_unauthorized';
  if request_signature is null or request_signature !~ '^[0-9a-f]{64}$' or issued_at_us is null or source_ip is null or source_ip='' or idempotency_key is null then return next; return; end if;
  select * into s from private.sales_lead_settings where id;
  if s.request_secret_current is null or octet_length(s.request_secret_current)<32 then result_code:='sales_lead_unavailable'; return next; return; end if;
  if source_ip ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' and length(source_ip)<=15 then
    ip_valid:=true;
    foreach octet in array string_to_array(source_ip,'.') loop
      if length(octet)>3 or octet::integer>255 then ip_valid:=false; end if;
    end loop;
  elsif length(source_ip) between 2 and 39 and source_ip ~ '^[0-9a-fA-F:]+$' then
    begin address:=source_ip::inet; ip_valid:=family(address)=6; exception when invalid_text_representation then ip_valid:=false; end;
  end if;
  if not ip_valid then return next; return; end if;
  if issued_at_us::numeric < extract(epoch from clock_timestamp())*1000000-120000000
    or issued_at_us::numeric > extract(epoch from clock_timestamp())*1000000+30000000 then return next; return; end if;
  fn:=btrim(regexp_replace(coalesce(first_name,''),ws||'+',' ','g'));
  cn:=btrim(regexp_replace(coalesce(company_name,''),ws||'+',' ','g'));
  em:=private.sales_lead_lower_email(regexp_replace(coalesce(email,''),'^'||ws||'+|'||ws||'+$','','g'));
  ph:=nullif(regexp_replace(coalesce(phone,''),'^'||ws||'+|'||ws||'+$','','g'),'');
  ne:=regexp_replace(replace(replace(coalesce(needs,''),E'\r\n',E'\n'),E'\r',E'\n'),'^'||ws||'+|'||ws||'+$','','g');
  canonical:='v1'||E'\n'||issued_at_us::text||E'\n'||idempotency_key::text||E'\n'||coalesce(caller::text,'-')||E'\n'||source_ip||E'\n'
    ||octet_length(fn)::text||':'||fn||E'\n'||octet_length(cn)::text||':'||cn||E'\n'||octet_length(em)::text||':'||em||E'\n'
    ||octet_length(coalesce(ph,''))::text||':'||coalesce(ph,'')||E'\n'||octet_length(ne)::text||':'||ne;
  if request_signature<>encode(extensions.hmac(canonical,s.request_secret_current,'sha256'),'hex')
    and (s.request_secret_previous is null or request_signature<>encode(extensions.hmac(canonical,s.request_secret_previous,'sha256'),'hex')) then return next; return; end if;
  perform pg_advisory_xact_lock(6101,hashtext(idempotency_key::text));
  select l.* into existing from public.sales_leads l where l.idempotency_key=submit_sales_lead.idempotency_key;
  has_existing:=found;
  if has_existing and (existing.first_name,existing.company_name,existing.email,existing.phone,existing.needs) is not distinct from (fn,cn,em,ph,ne) then
    insert into private.sales_lead_replay_state as rs(lead_id,replay_count,last_replay_at) values(existing.id,1,clock_timestamp())
      on conflict on constraint sales_lead_replay_state_pkey do update set replay_count=rs.replay_count+1,last_replay_at=excluded.last_replay_at where rs.replay_count<20;
    lead_id:=existing.id; result_code:='replay'; return next; return;
  end if;
  if current_setting('skillcheck.sales_lead_submit_barrier',true)='before_settings' then
    perform pg_advisory_lock(6190,1); perform pg_advisory_unlock(6190,1);
  end if;
  select * into s from private.sales_lead_settings where id for update;
  if s.request_secret_current is null then result_code:='sales_lead_unavailable'; return next; return; end if;
  if issued_at_us::numeric < extract(epoch from clock_timestamp())*1000000-120000000
    or issued_at_us::numeric > extract(epoch from clock_timestamp())*1000000+30000000
    or (request_signature<>encode(extensions.hmac(canonical,s.request_secret_current,'sha256'),'hex')
      and (s.request_secret_previous is null or request_signature<>encode(extensions.hmac(canonical,s.request_secret_previous,'sha256'),'hex'))) then return next; return; end if;
  if not s.leads_enabled then result_code:='sales_lead_unavailable'; return next; return; end if;
  fp:=encode(extensions.hmac(source_ip,s.request_secret_current,'sha256'),'hex');
  fps:=array[fp];
  if s.request_secret_previous is not null then fps:=array_append(fps,encode(extensions.hmac(source_ip,s.request_secret_previous,'sha256'),'hex')); end if;
  if current_setting('skillcheck.sales_lead_submit_barrier',true)='after_settings' then
    perform pg_advisory_lock(6191,1); perform pg_advisory_unlock(6191,1);
  end if;
  perform pg_advisory_xact_lock(6102,hashtext(fp));
  received_at:=clock_timestamp();
  if (select count(*) from private.sales_lead_attempts a where a.fingerprint_hash=any(fps) and a.attempted_at>=received_at-interval '10 minutes')>=8 then
    result_code:='sales_lead_rate_limited'; return next; return;
  end if;
  fields_valid:=char_length(fn) between 1 and 80 and char_length(cn) between 1 and 160 and char_length(em) between 3 and 254
    and em !~ ws and em ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and (ph is null or ph ~ '^[0-9+().\-\s]{5,32}$') and char_length(ne) between 10 and 1000
    and fn !~ '[\x01-\x1f\x7f]' and cn !~ '[\x01-\x1f\x7f]' and em !~ '[\x01-\x1f\x7f]'
    and coalesce(ph,'') !~ '[\x01-\x1f\x7f]' and ne !~ '[\x01-\x08\x0b-\x1f\x7f]';
  if not fields_valid or has_existing then
    insert into private.sales_lead_attempts(fingerprint_hash,attempted_at,result) values(fp,received_at,'rejected');
    result_code:=case when not fields_valid then 'sales_lead_invalid' else 'sales_lead_idempotency_conflict' end;
    return next; return;
  end if;
  perform pg_advisory_xact_lock(6103,hashtext(em));
  perform pg_advisory_xact_lock(6104,1);
  received_at:=clock_timestamp();
  delete from private.sales_lead_attempts a where a.fingerprint_hash=any(fps) and a.attempted_at<received_at-interval '48 hours';
  if (select count(*) from public.sales_leads l where l.fingerprint_hash=any(fps) and l.created_at>=received_at-interval '60 minutes')>=5
    or (select count(*) from public.sales_leads l where l.email=em and l.created_at>=received_at-interval '24 hours')>=3
    or (select count(*) from public.sales_leads l where l.created_at>=received_at-interval '60 minutes')>=30 then
    insert into private.sales_lead_attempts(fingerprint_hash,attempted_at,result) values(fp,received_at,'rate_limited');
    result_code:='sales_lead_rate_limited'; return next; return;
  end if;
  insert into public.sales_leads(idempotency_key,first_name,company_name,email,phone,needs,submitted_by,fingerprint_hash,created_at)
    values(idempotency_key,fn,cn,em,ph,ne,caller,fp,received_at) returning id into lead_id;
  insert into private.sales_lead_attempts(fingerprint_hash,attempted_at,result) values(fp,received_at,'accepted');
  result_code:='accepted'; return next;
end $$;
revoke all on function public.submit_sales_lead(uuid,text,text,text,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.submit_sales_lead(uuid,text,text,text,text,text,text,bigint,text) to anon,authenticated;
commit;
